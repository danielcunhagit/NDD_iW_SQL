#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod models;
mod db;
mod local_db;

use db::Database;
// Certifique-se de que CompanySummary está aqui
use models::{DashboardData, ProjectionData, ProductionRecord, MonitoringData, DeviceDetail, CompanySummary};
use tauri::{Window, Size, LogicalSize, Manager, AppHandle};
use tokio::sync::Mutex;
use chrono::{Datelike, Local, NaiveDate};
use std::collections::HashMap;
use regex::Regex;
use tokio::time::{sleep, Duration};
use sqlx::sqlite::SqlitePool;

struct AppState {
    db: Mutex<Option<Database>>,
    local_db: Mutex<Option<SqlitePool>>, // <--- NOVO: Memória da conexão local
    cache: Mutex<Option<DashboardData>>,
    monitoring_cache: Mutex<Option<MonitoringData>>,
    companies_map_cache: Mutex<Option<HashMap<String, Vec<String>>>>,
    companies_cache_year: Mutex<Option<i32>>,
}

// --- FUNÇÕES AUXILIARES ---
fn days_in_month(year: i32, month: u32) -> i64 {
    use chrono::NaiveDate;
    let next_month = if month == 12 { 1 } else { month + 1 };
    let next_year = if month == 12 { year + 1 } else { year };
    NaiveDate::from_ymd_opt(next_year, next_month, 1).unwrap().pred_opt().unwrap().day() as i64
}

fn calculate_smart_projection(
    source_name: &str,
    records: &Vec<ProductionRecord>,
    db_last_date_str: &str,
) -> (i64, i64) {
    let now = Local::now();
    
    // Tenta fazer o parse da data do banco. Se falhar, assume "hoje".
    let db_date = NaiveDate::parse_from_str(db_last_date_str, "%Y-%m-%d")
        .unwrap_or_else(|_| now.date_naive());
    
    // IMPORTANTE: A projeção deve ser baseada no ANO/MÊS da data de atualização do banco,
    // não necessariamente no relógio do computador (caso o banco esteja atrasado).
    let proj_year = db_date.year();
    let proj_month = db_date.month() as i32;
    let proj_day = db_date.day() as i64;

    // Encontra o registro de produção correspondente à data do banco
    let current_rec = records.iter().find(|r| 
        r.source == source_name && r.ano == proj_year && r.mes == proj_month
    );

    let (curr_pb, curr_cor) = match current_rec {
        Some(r) => (r.pb, r.cor),
        None => return (0, 0), // Se não tem produção neste mês, não tem projeção
    };

    let days_in_curr_month = days_in_month(proj_year, proj_month as u32);
    
    // Evita divisão por zero
    let day_divisor = if proj_day == 0 { 1 } else { proj_day };
    
    // Projeção Linear Simples (Regra de 3)
    // Se produziu X em 10 dias, vai produzir Y em 30.
    let rate_pb = curr_pb as f64 / day_divisor as f64;
    let rate_cor = curr_cor as f64 / day_divisor as f64;

    let proj_pb = (rate_pb * days_in_curr_month as f64) as i64;
    let proj_cor = (rate_cor * days_in_curr_month as f64) as i64;

    // Só retorna projeção se ela for maior que o realizado (para fazer sentido visualmente)
    // e se não for o último dia do mês
    if proj_day < days_in_curr_month {
        return (proj_pb, proj_cor);
    }

    (curr_pb, curr_cor)
}

fn clean_name_for_display(raw: &str) -> String {
    let sanitized = raw.replace('\u{00A0}', " ");
    let mut name = sanitized.to_uppercase();

    if let Some(idx) = name.find(" - ") {
        name = name[..idx].to_string();
    }

    name = name.trim_matches(|c| c == '-' || c == '.' || c == ',' || c == ' ').to_string();

    let re_valid = Regex::new(r"[^A-Z0-9\s&-]").unwrap();
    name = re_valid.replace_all(&name, " ").to_string();

    let suffixes = [
        " S A", " S.A.", " S.A", " SA", " S/A", 
        " LTDA", " LIMITADA", 
        " EIRELI", 
        " ME", " EPP", 
        " INC", " LLC", 
        " S.S.", " SS", 
        " COMERCIO E INDUSTRIA", " INDUSTRIA E COMERCIO", " COM E IND",
        " - FILIAL", " - MATRIZ"
    ];

    let mut changed = true;
    while changed {
        changed = false;
        let original_len = name.len();
        
        for suffix in suffixes.iter() {
            if name.ends_with(suffix) {
                name = name[..name.len() - suffix.len()].to_string();
                name = name.trim_end_matches(|c| c == '-' || c == '.' || c == ',' || c == ' ').to_string();
                changed = true;
                break;
            }
        }
        
        if name.len() == original_len { changed = false; }
    }

    Regex::new(r"\s+").unwrap().replace_all(&name, " ").trim().to_string()
}

fn generate_fingerprint(clean_name: &str) -> String {
    Regex::new(r"[^A-Z0-9]").unwrap().replace_all(clean_name, "").to_string()
}

// --- GERENCIAMENTO DE CACHE DE EMPRESAS ---
async fn get_or_create_company_map(state: tauri::State<'_, AppState>, year: i32) -> Result<HashMap<String, Vec<String>>, String> {
    {
        let cache_guard = state.companies_map_cache.lock().await;
        let year_guard = state.companies_cache_year.lock().await;
        if let (Some(map), Some(cached_year)) = (cache_guard.as_ref(), year_guard.as_ref()) {
            if *cached_year == year { return Ok(map.clone()); }
        }
    }

    let mut raw_companies = Vec::new();
    let mut loaded_from_local = false;

    // TENTA O BANCO LOCAL SEM TRAVAS! Bateu, voltou!
    if let Some(local_pool) = state.local_db.lock().await.as_ref() {
        if let Ok(comps) = local_db::LocalDatabase::get_local_active_companies_in_year(local_pool, year).await {
            if !comps.is_empty() {
                raw_companies = comps;
                loaded_from_local = true;
            }
        }
    }

    if !loaded_from_local {
        let mut db_guard = state.db.lock().await;
        if db_guard.is_none() {
             let conn_str = "mssql://ndd_viewer:ioas%21%40%23ibusad%24%25%24%21%40asd3@192.168.41.22/Db_RPA?encrypt=true&trustServerCertificate=true";
             let db = Database::new(conn_str).await.map_err(|e| e.to_string())?;
             *db_guard = Some(db);
        }
        let db = db_guard.as_ref().unwrap();
        raw_companies = db.get_active_companies_in_year(year).await.map_err(|e| e.to_string())?;
    }

    let mut temp_map: HashMap<String, (String, Vec<String>)> = HashMap::new();
    for (raw, _) in raw_companies {
        let display = clean_name_for_display(&raw);
        if display.len() < 2 { continue; }
        let fingerprint = generate_fingerprint(&display);
        if fingerprint.is_empty() { continue; }
        temp_map.entry(fingerprint).and_modify(|(current_display, raw_list)| {
            if display.len() > current_display.len() { *current_display = display.clone(); }
            raw_list.push(raw.clone());
        }).or_insert((display, vec![raw]));
    }
    let mut final_map: HashMap<String, Vec<String>> = HashMap::new();
    for (_, (display, raw_list)) in temp_map { final_map.insert(display, raw_list); }
    
    let mut cache_guard = state.companies_map_cache.lock().await;
    let mut year_guard = state.companies_cache_year.lock().await;
    *cache_guard = Some(final_map.clone());
    *year_guard = Some(year);
    
    Ok(final_map)
}

#[tauri::command]
fn quit_app() { std::process::exit(0); }

// --- COMANDO FALTANTE ADICIONADO AQUI ---
#[tauri::command]
async fn fetch_month_summary_cmd(state: tauri::State<'_, AppState>, year: i32, month: i32) -> Result<Vec<CompanySummary>, String> {
    let local_pool_opt = state.local_db.lock().await.clone();
    
    if let Some(local_pool) = local_pool_opt {
        // REMOVIDO: A checagem estrita de sincronização. Se tem dado local, use!
        if let Ok(summary) = local_db::LocalDatabase::get_local_month_company_summary(&local_pool, year, month).await {
            if !summary.is_empty() {
                return Ok(summary);
            }
        }
    }

    // Fallback para a nuvem se o local estiver 100% vazio
    let db_guard = state.db.lock().await;
    if let Some(db) = db_guard.as_ref() {
        if let Ok(data) = db.get_month_company_summary(year, month).await {
            return Ok(data);
        }
    }
    
    // MÁGICA: Em vez de disparar Erro e piscar a tela vermelha, retorna array vazio pacientemente.
    Ok(vec![])
}

#[tauri::command]
async fn fetch_month_details_cmd(state: tauri::State<'_, AppState>, year: i32, month: i32, company: Option<String>) -> Result<Vec<DeviceDetail>, String> {
    let target_raw_names = if let Some(comp_name) = company.as_deref() {
        if !comp_name.trim().is_empty() {
            // Tratamento de erro suave no mapeamento
            let map = get_or_create_company_map(state.clone(), year).await.unwrap_or_default();
            map.get(comp_name).cloned() 
        } else { None }
    } else { None };

    let local_pool_opt = state.local_db.lock().await.clone();
    
    if let Some(local_pool) = local_pool_opt {
        if let Ok(details) = local_db::LocalDatabase::get_local_month_details(&local_pool, year, month, target_raw_names.clone()).await {
            if !details.is_empty() {
                return Ok(details);
            }
        }
    }

    let db_guard = state.db.lock().await;
    if let Some(db) = db_guard.as_ref() {
        if let Ok(data) = db.get_month_details(year, month, target_raw_names).await {
            return Ok(data);
        }
    }
    
    Ok(vec![])
}

#[tauri::command]
async fn fetch_companies(state: tauri::State<'_, AppState>, year: i32) -> Result<Vec<String>, String> {
    let map = get_or_create_company_map(state, year).await?;
    let mut list: Vec<String> = map.keys().cloned().collect();
    list.sort();
    Ok(list)
}

#[tauri::command]
async fn perform_initial_load(app: AppHandle, window: Window, state: tauri::State<'_, AppState>) -> Result<DashboardData, String> {
    let _ = window.emit("splash-status", "Acessando banco de dados local...");
    let current_year = Local::now().year();
    let previous_year = current_year - 1;

    // TENTATIVA 1: O Caminho Ultrarrápido (Offline-First)
    if let Ok(local_db) = local_db::LocalDatabase::init(&app).await {
        let pool = local_db.pool.clone();
        
        {
            let mut local_guard = state.local_db.lock().await;
            *local_guard = Some(pool.clone());
        }

        // ---> MÁGICA DO STARTUP INSTANTÂNEO (CACHE JSON DE 1ms) <---
        if let Some(json_str) = local_db::LocalDatabase::get_cache(&pool, "startup_dashboard_data").await {
            if let Ok(cached_data) = serde_json::from_str::<DashboardData>(&json_str) {
                
                // MÁGICA UX (Labor Illusion): Mostra os passos rapidamente para passar sensação de robustez
                let _ = window.emit("splash-status", "Acessando banco de dados local...");
                sleep(Duration::from_millis(350)).await;
                
                let _ = window.emit("splash-status", "Restaurando visão consolidada...");
                sleep(Duration::from_millis(350)).await;
                
                {
                    let mut cache_guard = state.cache.lock().await;
                    *cache_guard = Some(cached_data.clone());
                }

                // Dispara toda a carga pesada DEPOIS de liberar a tela
                let app_clone = app.clone();
                tokio::spawn(async move {
                    let state = app_clone.state::<AppState>();
                    let _ = get_or_create_company_map(state.clone(), current_year).await;
                    let _ = app_clone.emit_all("companies-ready", ());

                    let _ = app_clone.emit_all("sync-status", "Tentando conexão com a nuvem...");
                    let conn_str = "mssql://ndd_viewer:ioas%21%40%23ibusad%24%25%24%21%40asd3@192.168.41.22/Db_RPA?encrypt=true&trustServerCertificate=true";
                    
                    if let Ok(db) = Database::new(conn_str).await {
                        let _ = app_clone.emit_all("sync-status", "Conectado! Sincronizando dados...");
                        let m_pool = db.get_pool_clone();
                        
                        let local_pool_opt = state.local_db.lock().await.clone();
                        if let Some(l_db) = local_pool_opt {
                            local_db::LocalDatabase::start_sync_worker(app_clone.clone(), l_db.clone(), m_pool);
                            
                            if let Ok(mif_data) = db.get_monitoring_stats().await {
                                if let Ok(json) = serde_json::to_string(&mif_data) {
                                    let _ = local_db::LocalDatabase::set_cache(&l_db, "mif_stats", &json).await;
                                }
                            }
                            if let Ok(mif_summary) = db.get_monitoring_company_summary().await {
                                if let Ok(json) = serde_json::to_string(&mif_summary) {
                                    let _ = local_db::LocalDatabase::set_cache(&l_db, "mif_summary", &json).await;
                                }
                            }
                        }
                        
                        let mut db_guard = state.db.lock().await;
                        *db_guard = Some(db);
                    } else {
                        let _ = app_clone.emit_all("startup-sync-failed", "falha"); 
                        let _ = app_clone.emit_all("sync-status", "Modo Offline: Usando dados locais.");
                        sleep(Duration::from_secs(4)).await;
                        let _ = app_clone.emit_all("sync-status", "");
                    }
                });

                // Continua a animação da tela enquanto o robô acima já está trabalhando!
                let _ = window.emit("splash-status", "Consolidando parque de empresas e filtros...");
                sleep(Duration::from_millis(350)).await;
                
                let _ = window.emit("splash-status", "Pronto!");
                sleep(Duration::from_millis(200)).await;

                // RETORNO IMEDIATO! O React nem vai perceber que o banco existe.
                return Ok(cached_data);
            }
        }

        // --- FIM DA MÁGICA. DAQUI PARA BAIXO RODA SÓ NA 1ª VEZ NA VIDA DO APP ---
        let sync_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM sync_status").fetch_one(&pool).await.unwrap_or((0,));
        let is_partial = sync_count.0 > 0 && sync_count.0 < 50; 

        if let Ok(p) = local_db::LocalDatabase::get_local_production(&pool, 2020, None).await {
            if !p.is_empty() {
                if is_partial {
                    let _ = window.emit("splash-status", "Usando dados disponíveis no banco local, mas baixando dados faltantes...");
                    sleep(Duration::from_millis(1500)).await;
                } else {
                    let _ = window.emit("splash-status", "Carregando os dados do banco local...");
                }
                
                let _ = window.emit("splash-status", "Processando dados de comunicação e conectividade...");
            
                if let Ok(c) = local_db::LocalDatabase::get_local_communication(&pool, 2020, None).await {
                    let last_ndd = local_db::LocalDatabase::get_local_last_date(&pool, "NDD").await;
                    let last_iw = local_db::LocalDatabase::get_local_last_date(&pool, "IW").await;
                    
                    let total_equipments = p.iter().filter(|x| x.ano == current_year).map(|x| x.devices as i64).max().unwrap_or(0);
                    let (ndd_pb, ndd_cor) = calculate_smart_projection("NDD", &p, &last_ndd);
                    let (iw_pb, iw_cor) = calculate_smart_projection("IW", &p, &last_iw);

                    let data = DashboardData {
                        production: p, communication: c, last_update_ndd: last_ndd, last_update_iw: last_iw,
                        projection: ProjectionData { ndd_pb, ndd_cor, iw_pb, iw_cor },
                        total_equipments, total_companies: 0,
                    };

                    let mut cache_guard = state.cache.lock().await;
                    *cache_guard = Some(data.clone());

                    // ---> SALVA A PRIMEIRA "FOTO" NO CACHE! As próximas vezes cairão na mágica de cima! <---
                    if let Ok(json) = serde_json::to_string(&data) {
                        let _ = local_db::LocalDatabase::set_cache(&pool, "startup_dashboard_data", &json).await;
                    }

                    let _ = window.emit("splash-status", "Consolidando parque de empresas e filtros...");

                    let _ = window.emit("splash-status", "Pronto!");
                    return Ok(data);
                }
            }
        }
    }

    // TENTATIVA 2: O Fallback Tradicional (Só cai aqui se você deletar o arquivo rpa_cache.db)
    let _ = window.emit("splash-status", "Primeiro acesso. Os dados baixados serão exclusivamente da nuvem...");
    sleep(Duration::from_millis(1000)).await;
    let conn_str = "mssql://ndd_viewer:ioas%21%40%23ibusad%24%25%24%21%40asd3@192.168.41.22/Db_RPA?encrypt=true&trustServerCertificate=true";
    let mut db_guard = state.db.lock().await;
    if db_guard.is_none() {
        let db = Database::new(conn_str).await.map_err(|e| e.to_string())?;
        *db_guard = Some(db);
    }
    let db = db_guard.as_ref().unwrap();

    let _ = window.emit("splash-status", format!("Baixando dados iniciais da Nuvem ({} - {})...", previous_year, current_year));
    let production = db.get_production_current(previous_year, None).await.map_err(|e| e.to_string())?;
    let communication = db.get_communication_current(previous_year, None).await.map_err(|e| e.to_string())?;

    let (stats_res, dates_data) = tokio::join!(
        db.get_snapshot_stats(),
        async { tokio::join!(db.get_last_date("vw_NDD"), db.get_last_date("vw_IW_Main")) }
    );
    let (total_equipments, total_companies) = stats_res.map_err(|e| e.to_string())?;
    let (last_update_ndd, last_update_iw) = dates_data;

    let (ndd_pb, ndd_cor) = calculate_smart_projection("NDD", &production, &last_update_ndd);
    let (iw_pb, iw_cor) = calculate_smart_projection("IW", &production, &last_update_iw);

    let data = DashboardData {
        production, communication, last_update_ndd, last_update_iw,
        projection: ProjectionData { ndd_pb, ndd_cor, iw_pb, iw_cor },
        total_equipments, total_companies,
    };

    let mut cache_guard = state.cache.lock().await;
    *cache_guard = Some(data.clone());

    // MÁGICA 2: Extrai a conexão na linha principal para que o robô não espere o MIF carregar!
    let m_pool = db.get_pool_clone();

    // Dispara a nuvem no fundo SILENCIOSAMENTE sem travar o App
    let app_clone = app.clone();
    tokio::spawn(async move {
        let _ = app_clone.emit_all("sync-status", "Iniciando download dos dados em segundo plano...");
        let state = app_clone.state::<AppState>();
        
        let local_pool_opt = state.local_db.lock().await.clone();
        if let Some(l_db) = local_pool_opt {
            // Inicia o trabalhador 100% livre de bloqueios
            local_db::LocalDatabase::start_sync_worker(app_clone.clone(), l_db.clone(), m_pool);
        } else {
            // ---> NOVA TRAVA DE SEGURANÇA AQUI <---
            // Se falhar a inicialização do SQLite por qualquer motivo, avisa na tela!
            let _ = app_clone.emit_all("sync-status", "Erro interno: Banco local não carregou. Verifique permissões.");
        }
        
        let _ = get_or_create_company_map(state.clone(), current_year).await;
        let _ = app_clone.emit_all("companies-ready", ());
    });
    Ok(data)
}

#[tauri::command]
async fn fetch_full_history(window: Window, state: tauri::State<'_, AppState>) -> Result<DashboardData, String> {
    let _ = window.emit("history-status", "Buscando histórico completo...");
    
    let mut db_guard = state.db.lock().await;
    if db_guard.is_none() {
         let conn_str = "mssql://ndd_viewer:ioas%21%40%23ibusad%24%25%24%21%40asd3@192.168.41.22/Db_RPA?encrypt=true&trustServerCertificate=true";
         let db = Database::new(conn_str).await.map_err(|e| e.to_string())?;
         *db_guard = Some(db);
    }
    let db = db_guard.as_ref().unwrap();
    
    let current_year = Local::now().year();
    let cutoff_year = current_year - 1;

    let (prod_res, comm_res) = tokio::join!(
        db.get_production_history(cutoff_year),
        db.get_communication_history(cutoff_year)
    );

    let prod_hist = prod_res.map_err(|e| e.to_string())?;
    let comm_hist = comm_res.map_err(|e| e.to_string())?;

    let mut cache_guard = state.cache.lock().await;
    if let Some(data) = cache_guard.as_mut() {
        data.production.extend(prod_hist.clone());
        data.communication.extend(comm_hist.clone());
    }

    Ok(DashboardData {
        production: prod_hist, communication: comm_hist,
        last_update_ndd: "".to_string(), last_update_iw: "".to_string(),
        projection: ProjectionData::default(), total_equipments: 0, total_companies: 0,
    })
}

#[tauri::command]
fn finalize_startup(window: Window) {
    // Clonamos o controle remoto da janela para o Rust não reclamar de uso de memória
    let window_clone = window.clone();
    
    // Devolvemos o comando para a Thread Principal (Agora é 100% seguro)
    let _ = window.run_on_main_thread(move || {
        let _ = window_clone.set_size(Size::Logical(LogicalSize { width: 1050.0, height: 700.0 }));
        let _ = window_clone.set_decorations(true);
        let _ = window_clone.set_resizable(true);
        let _ = window_clone.center();
        let _ = window_clone.set_focus();
    });
}

#[tauri::command]
async fn fetch_dashboard_data(window: Window, state: tauri::State<'_, AppState>, year: i32, company: Option<String>) -> Result<DashboardData, String> {
    // 1. Trata o caso do React enviar uma string vazia ""
    let company_opt = match company {
        Some(ref c) if c.trim().is_empty() => None,
        _ => company,
    };

    let target_raw_names = if let Some(comp_name) = company_opt.as_deref() {
        let map = get_or_create_company_map(state.clone(), year).await?;
        map.get(comp_name).cloned() 
    } else { None };

    // Se filtrou uma empresa que não existe no mapa, retorna vazio
    if company_opt.is_some() && target_raw_names.is_none() {
        return Ok(DashboardData {
            production: vec![], communication: vec![], 
            last_update_ndd: "N/D".to_string(), last_update_iw: "N/D".to_string(),
            projection: ProjectionData::default(), total_equipments: 0, total_companies: 0
        });
    }
    
    let mut production = vec![];
    let mut communication = vec![];
    let mut loaded_from_local = false;
    let mut last_update_ndd = "N/D".to_string();
    let mut last_update_iw = "N/D".to_string();

    let local_pool_opt = state.local_db.lock().await.clone();
    
    if let Some(local_pool) = local_pool_opt {
        if company_opt.is_none() {
            // MÁGICA DO MERGE HÍBRIDO (LOCAL + CACHE DA NUVEM)
            if let Ok(p) = local_db::LocalDatabase::get_local_production(&local_pool, 2020, None).await {
                if let Ok(c) = local_db::LocalDatabase::get_local_communication(&local_pool, 2020, None).await {
                    let synced_years = local_db::LocalDatabase::get_synced_years(&local_pool).await;
                    let cache_guard = state.cache.lock().await;
                    
                    if let Some(cached) = cache_guard.as_ref() {
                        // 1. Pega do banco local APENAS os anos que já baixaram 100%
                        let mut merged_p: Vec<_> = p.into_iter().filter(|r| synced_years.contains(&r.ano)).collect();
                        // 2. Preenche os anos incompletos com os dados "fotografados" da nuvem
                        let mut cached_p: Vec<_> = cached.production.iter().filter(|r| !synced_years.contains(&r.ano)).cloned().collect();
                        merged_p.append(&mut cached_p);
                        production = merged_p;
                        
                        let mut merged_c: Vec<_> = c.into_iter().filter(|r| synced_years.contains(&r.ano)).collect();
                        let mut cached_c: Vec<_> = cached.communication.iter().filter(|r| !synced_years.contains(&r.ano)).cloned().collect();
                        merged_c.append(&mut cached_c);
                        communication = merged_c;
                    } else {
                        production = p; communication = c;
                    }
                    
                    loaded_from_local = true;
                    last_update_ndd = local_db::LocalDatabase::get_local_last_date(&local_pool, "NDD").await;
                    last_update_iw = local_db::LocalDatabase::get_local_last_date(&local_pool, "IW").await;
                }
            }
        } else {
            // COM FILTRO DE EMPRESA: Não podemos usar a foto geral, usamos o banco local (mesmo que parcial)
            let is_synced = local_db::LocalDatabase::is_year_fully_synced(&local_pool, year).await;
            if is_synced {
                if let Ok(p) = local_db::LocalDatabase::get_local_production(&local_pool, 2020, target_raw_names.clone()).await {
                    if let Ok(c) = local_db::LocalDatabase::get_local_communication(&local_pool, 2020, target_raw_names.clone()).await {
                        production = p; communication = c;
                        loaded_from_local = true;
                        last_update_ndd = local_db::LocalDatabase::get_local_last_date(&local_pool, "NDD").await;
                        last_update_iw = local_db::LocalDatabase::get_local_last_date(&local_pool, "IW").await;
                    }
                }
            } else {
                if let Ok(p) = local_db::LocalDatabase::get_local_production(&local_pool, 2020, target_raw_names.clone()).await {
                    if !p.is_empty() {
                        if let Ok(c) = local_db::LocalDatabase::get_local_communication(&local_pool, 2020, target_raw_names.clone()).await {
                            production = p; communication = c;
                            loaded_from_local = true;
                            last_update_ndd = local_db::LocalDatabase::get_local_last_date(&local_pool, "NDD").await;
                            last_update_iw = local_db::LocalDatabase::get_local_last_date(&local_pool, "IW").await;
                        }
                    }
                }
            }
        }
    }

    if !loaded_from_local {
        let db_guard = state.db.lock().await;
        let db = db_guard.as_ref().ok_or("Erro de conexão com servidor")?;
        let _ = window.emit("splash-status", "Lendo da Nuvem (Servidor)...");
        production = db.get_production_current(2020, target_raw_names.clone()).await.map_err(|e| e.to_string())?;
        communication = db.get_communication_current(2020, target_raw_names).await.map_err(|e| e.to_string())?;
        
        let cache_guard = state.cache.lock().await;
        if let Some(c) = cache_guard.as_ref() {
            last_update_ndd = c.last_update_ndd.clone();
            last_update_iw = c.last_update_iw.clone();
        }
    }

    let mut total_equipments = 0;
    if !communication.is_empty() {
        let last_month = communication.iter().filter(|c| c.ano == year).map(|c| c.mes).max().unwrap_or(0);
        if last_month > 0 {
            total_equipments = communication.iter()
                .filter(|c| c.ano == year && c.mes == last_month)
                .map(|c| (c.connected + c.disconnected) as i64)
                .sum();
        }
    }    
    
    let total_companies = if company_opt.is_some() { 1 } else { 0 };
    let p = production;
    
    let (np, nc) = calculate_smart_projection("NDD", &p, &last_update_ndd);
    let (ip, ic) = calculate_smart_projection("IW", &p, &last_update_iw);

    let final_data = DashboardData {
        production: p, communication, last_update_ndd, last_update_iw,
        projection: ProjectionData { ndd_pb: np, ndd_cor: nc, iw_pb: ip, iw_cor: ic },
        total_equipments, total_companies
    };

    // ---> MÁGICA DO CACHE: Atualiza a foto de "arranque rápido" sempre que a visão geral for carregada!
    if company_opt.is_none() {
        let local_pool_opt = state.local_db.lock().await.clone();
        if let Some(l_pool) = local_pool_opt {
            if let Ok(json) = serde_json::to_string(&final_data) {
                let _ = local_db::LocalDatabase::set_cache(&l_pool, "startup_dashboard_data", &json).await;
            }
        }
        
        // NOVO: Atualiza a memória interna do Rust com o "Merge Perfeito" para garantir que os dados da Nuvem não se percam!
        let mut cache_guard = state.cache.lock().await;
        *cache_guard = Some(final_data.clone());
    }

    Ok(final_data)
}

#[tauri::command]
async fn fetch_monitoring_company_summary(state: tauri::State<'_, AppState>) -> Result<Vec<models::MonitoringCompanySummary>, String> {
    let local_pool_opt = state.local_db.lock().await.clone();
    
    if let Some(local_pool) = local_pool_opt {
        if let Some(json_str) = local_db::LocalDatabase::get_cache(&local_pool, "mif_summary").await {
            if let Ok(data) = serde_json::from_str::<Vec<models::MonitoringCompanySummary>>(&json_str) {
                return Ok(data);
            }
        }
    }
    
    let db_guard = state.db.lock().await;
    if let Some(db) = db_guard.as_ref() {
        return db.get_monitoring_company_summary().await.map_err(|e| e.to_string());
    }
    
    // MÁGICA: Se estiver OFFLINE e sem cache, devolve lista vazia em vez de dar erro infinito!
    Ok(vec![])
}

#[tauri::command]
async fn fetch_monitoring_data(window: Window, state: tauri::State<'_, AppState>) -> Result<MonitoringData, String> {
    {
        let cache = state.monitoring_cache.lock().await;
        if let Some(data) = cache.as_ref() { 
            let _ = window.emit("monitoring-status", "Diagrama carregado (Cache).");
            return Ok(data.clone()); 
        }
    }
    
    let local_pool_opt = state.local_db.lock().await.clone();
    
    if let Some(local_pool) = local_pool_opt {
        if let Some(json_str) = local_db::LocalDatabase::get_cache(&local_pool, "mif_stats").await {
            if let Ok(data) = serde_json::from_str::<MonitoringData>(&json_str) {
                let mut cache = state.monitoring_cache.lock().await;
                *cache = Some(data.clone());
                let _ = window.emit("monitoring-status", "Diagrama carregado (Cache).");
                return Ok(data);
            }
        }
    }

    let db_guard = state.db.lock().await;
    if let Some(db) = db_guard.as_ref() {
        let _ = window.emit("monitoring-status", "Analisando parque (MIF)...");
        let result = db.get_monitoring_stats().await.map_err(|e| e.to_string())?;
        
        let mut cache = state.monitoring_cache.lock().await;
        *cache = Some(result.clone());
        return Ok(result);
    }

    // MÁGICA: Se estiver OFFLINE e sem cache, devolve zeros em vez de dar erro infinito!
    let _ = window.emit("monitoring-status", "Monitoramento indisponível offline.");
    Ok(MonitoringData::default())
}

#[derive(serde::Serialize, sqlx::FromRow)]
pub struct DailyProd {
    pub dia: i32,
    pub total: i64,
}

#[tauri::command]
async fn fetch_daily_production(
    state: tauri::State<'_, AppState>, 
    year: i32, 
    month: i32, 
    source: String, 
    company: Option<String>
) -> Result<Vec<DailyProd>, String> {
    let target_raw_names = if let Some(comp_name) = company.as_deref() {
        if !comp_name.trim().is_empty() {
            let map = get_or_create_company_map(state.clone(), year).await.unwrap_or_default();
            map.get(comp_name).cloned() 
        } else { None }
    } else { None };

    if company.is_some() && target_raw_names.is_none() { return Ok(vec![]); }

    let local_pool_opt = state.local_db.lock().await.clone();
    
    if let Some(local_pool) = local_pool_opt {
        if let Ok(data) = local_db::LocalDatabase::get_local_daily_production(&local_pool, year, month, source.clone(), target_raw_names.clone()).await {
            if !data.is_empty() {
                return Ok(data);
            }
        }
    }

    let db_guard = state.db.lock().await;
    if let Some(db) = db_guard.as_ref() {
        if let Ok(data) = db.get_daily_production(year, month, source, target_raw_names).await {
            return Ok(data);
        }
    }
    
    Ok(vec![])
}

#[tauri::command]
async fn trigger_background_sync(app: AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let app_clone = app.clone();
    
    // Pega APENAS a conexão local aqui fora, que é segura de clonar
    let local_pool_opt = state.local_db.lock().await.clone();
    
    tokio::spawn(async move {
        let conn_str = "mssql://ndd_viewer:ioas%21%40%23ibusad%24%25%24%21%40asd3@192.168.41.22/Db_RPA?encrypt=true&trustServerCertificate=true";
        
        if let Ok(db) = Database::new(conn_str).await {
            let _ = app_clone.emit_all("sync-status", "Conectado! Verificando atualizações...");
            
            // Clona a conexão antes de travar o banco principal
            let m_pool = db.get_pool_clone();
            
            if let Some(l_db) = local_pool_opt {
                // 1. INICIA O DOWNLOAD IMEDIATAMENTE (Destrava a interface)
                local_db::LocalDatabase::start_sync_worker(app_clone.clone(), l_db.clone(), m_pool);
                
                // 2. AVISA A TELA DO MIF EM UM CANAL SEPARADO
                let _ = app_clone.emit_all("monitoring-status", "Atualizando estatísticas de Monitoramento...");
                
                // Usa a variável 'db' diretamente para o cache local da árvore do MIF
                if let Ok(mif_data) = db.get_monitoring_stats().await {
                    if let Ok(json) = serde_json::to_string(&mif_data) {
                        let _ = local_db::LocalDatabase::set_cache(&l_db, "mif_stats", &json).await;
                    }
                }
                if let Ok(mif_summary) = db.get_monitoring_company_summary().await {
                    if let Ok(json) = serde_json::to_string(&mif_summary) {
                        let _ = local_db::LocalDatabase::set_cache(&l_db, "mif_summary", &json).await;
                    }
                }
            }

            // MÁGICA DE MEMÓRIA: Recupera o Estado Global de forma segura DENTRO da thread!
            let state_inside = app_clone.state::<AppState>();
            let mut guard = state_inside.db.lock().await;
            *guard = Some(db);

        } else {
            let _ = app_clone.emit_all("sync-failed", "falha"); 
            let _ = app_clone.emit_all("sync-status", "Falha na conexão: Modo Offline mantido.");
            sleep(Duration::from_secs(4)).await;
            let _ = app_clone.emit_all("sync-status", "");
        }
    });
    
    Ok(())
}

#[tauri::command]
async fn check_for_updates(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    let conn_str = "mssql://ndd_viewer:ioas%21%40%23ibusad%24%25%24%21%40asd3@192.168.41.22/Db_RPA?encrypt=true&trustServerCertificate=true";
    let db = Database::new(conn_str).await.map_err(|e| e.to_string())?;
    
    let cloud_ndd = db.get_last_date("vw_NDD").await;
    let cloud_iw = db.get_last_date("vw_IW_Main").await;
    
    let mut local_ndd = String::new();
    let mut local_iw = String::new();
    
    // MÁGICA: Pega a data máxima que o disco local já conhece
    let local_pool_opt = state.local_db.lock().await.clone();
    if let Some(local_pool) = local_pool_opt {
        local_ndd = local_db::LocalDatabase::get_local_last_date(&local_pool, "NDD").await;
        local_iw = local_db::LocalDatabase::get_local_last_date(&local_pool, "IW").await;
    }
    
    // Se as datas da nuvem forem idênticas às do computador, não tem novidade!
    if cloud_ndd == local_ndd && cloud_iw == local_iw && cloud_ndd != "N/D" && cloud_iw != "N/D" {
        return Ok(false);
    }
    
    Ok(true)
}

fn main() {
    // --- TRAVA DE INSTÂNCIA ÚNICA (SINGLE INSTANCE LOCK) ---
    // Cria uma conexão local invisível na porta 58432.
    // Se a porta já estiver em uso, significa que o programa já está rodando.
    let _singleton_lock = match std::net::TcpListener::bind("127.0.0.1:58432") {
        Ok(listener) => listener,
        Err(_) => {
            // O programa já está aberto! Fecha esta nova tentativa silenciosamente.
            std::process::exit(0);
        }
    };

    tauri::Builder::default()
        .manage(AppState { 
            db: Mutex::new(None), cache: Mutex::new(None), 
            local_db: Mutex::new(None),
            monitoring_cache: Mutex::new(None), companies_map_cache: Mutex::new(None),
            companies_cache_year: Mutex::new(None)
        })
        .invoke_handler(tauri::generate_handler![
            fetch_dashboard_data, fetch_companies, perform_initial_load, 
            fetch_full_history, finalize_startup, quit_app, fetch_monitoring_data,
            fetch_month_details_cmd, fetch_month_summary_cmd, fetch_monitoring_company_summary,
            fetch_daily_production, trigger_background_sync, check_for_updates // <--- ADICIONADO AQUI
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}