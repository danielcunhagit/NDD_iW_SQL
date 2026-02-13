#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod models;
mod db;

use db::Database;
// Certifique-se de que CompanySummary está aqui
use models::{DashboardData, ProjectionData, ProductionRecord, MonitoringData, DeviceDetail, CompanySummary};
use tauri::{Window, Size, LogicalSize, Manager, AppHandle};
use tokio::sync::Mutex;
use chrono::{Datelike, Local, NaiveDate};
use std::collections::HashMap;
use regex::Regex;
use tokio::time::{sleep, Duration};

struct AppState {
    db: Mutex<Option<Database>>,
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
            if *cached_year == year {
                return Ok(map.clone());
            }
        }
    }

    let mut db_guard = state.db.lock().await;
    if db_guard.is_none() {
         let conn_str = "mssql://ndd_viewer:ioas%21%40%23ibusad%24%25%24%21%40asd3@192.168.41.22/Db_RPA?encrypt=true&trustServerCertificate=true";
         let db = Database::new(conn_str).await.map_err(|e| e.to_string())?;
         *db_guard = Some(db);
    }
    let db = db_guard.as_ref().unwrap();
    
    let raw_companies = db.get_active_companies_in_year(year).await.map_err(|e| e.to_string())?;
    
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
    let db_guard = state.db.lock().await;
    let db = db_guard.as_ref().ok_or("Erro de conexão")?;
    let summary = db.get_month_company_summary(year, month).await.map_err(|e| e.to_string())?;
    Ok(summary)
}

#[tauri::command]
async fn fetch_month_details_cmd(state: tauri::State<'_, AppState>, year: i32, month: i32, company: Option<String>) -> Result<Vec<DeviceDetail>, String> {
    let target_raw_names = if let Some(comp_name) = company.as_deref() {
        if !comp_name.trim().is_empty() {
            let map = get_or_create_company_map(state.clone(), year).await?;
            map.get(comp_name).cloned() 
        } else { None }
    } else { None };

    let db_guard = state.db.lock().await;
    let db = db_guard.as_ref().ok_or("Erro de conexão")?;
    let details = db.get_month_details(year, month, target_raw_names).await.map_err(|e| e.to_string())?;
    Ok(details)
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
    println!(">>> [INIT] Iniciando...");
    let _ = window.emit("splash-status", "Conectando ao banco de dados...");
    sleep(Duration::from_millis(500)).await;

    let conn_str = "mssql://ndd_viewer:ioas%21%40%23ibusad%24%25%24%21%40asd3@192.168.41.22/Db_RPA?encrypt=true&trustServerCertificate=true";
    let mut db_guard = state.db.lock().await;
    if db_guard.is_none() {
        let db = Database::new(conn_str).await.map_err(|e| e.to_string())?;
        *db_guard = Some(db);
    }
    let db = db_guard.as_ref().unwrap();

    let now = Local::now();
    let current_year = now.year();
    let previous_year = current_year - 1;

    let _ = window.emit("splash-status", format!("Carregando dados ({} - {})...", previous_year, current_year));
    sleep(Duration::from_millis(500)).await;
    
    let production = db.get_production_current(previous_year, None).await.map_err(|e| e.to_string())?;

    let _ = window.emit("splash-status", "Analisando Comunicação...");
    sleep(Duration::from_millis(500)).await;
    let communication = db.get_communication_current(previous_year, None).await.map_err(|e| e.to_string())?;

    let _ = window.emit("splash-status", "Consolidando estatísticas do parque...");
    sleep(Duration::from_millis(500)).await;
    let (stats_res, dates_data) = tokio::join!(
        db.get_snapshot_stats(),
        async { tokio::join!(db.get_last_date("vw_NDD"), db.get_last_date("vw_IW_Main")) }
    );
    let (total_equipments, total_companies) = stats_res.map_err(|e| e.to_string())?;
    let (last_update_ndd, last_update_iw) = dates_data;

    let _ = window.emit("splash-status", "Calculando projeções do mês...");
    sleep(Duration::from_millis(500)).await;
    
    let (ndd_pb, ndd_cor) = calculate_smart_projection("NDD", &production, &last_update_ndd);
    let (iw_pb, iw_cor) = calculate_smart_projection("IW", &production, &last_update_iw);

    let data = DashboardData {
        production, communication, last_update_ndd, last_update_iw,
        projection: ProjectionData { ndd_pb, ndd_cor, iw_pb, iw_cor },
        total_equipments, total_companies,
    };

    let mut cache_guard = state.cache.lock().await;
    *cache_guard = Some(data.clone());

    // Dispara o carregamento do mapa de empresas em background
    let app_clone = app.clone(); 
    tokio::spawn(async move {
        // Pequeno delay para garantir que a UI carregou e está ouvindo
        sleep(Duration::from_millis(1000)).await;
        
        let state = app_clone.state::<AppState>();
        // Força o cache do ano atual
        let _ = get_or_create_company_map(state, current_year).await;
        
        // Emite o evento avisando que acabou
        let _ = app_clone.emit_all("companies-ready", ());
    });

    let _ = window.emit("splash-status", "Pronto!");
    
    // Retorna os dados para fechar o splash screen
    Ok(data)
}

#[tauri::command]
async fn fetch_full_history(window: Window, state: tauri::State<'_, AppState>) -> Result<DashboardData, String> {
    let _ = window.emit("history-status", "Buscando histórico completo...");
    let db_guard = state.db.lock().await;
    let db = db_guard.as_ref().ok_or("Banco desconectado")?;
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
async fn finalize_startup(window: Window) {
    let _ = window.set_size(Size::Logical(LogicalSize { width: 1050.0, height: 700.0 }));
    let _ = window.set_decorations(true);
    let _ = window.set_resizable(true);
    let _ = window.center();
    let _ = window.set_focus();
}

#[tauri::command]
async fn fetch_dashboard_data(window: Window, state: tauri::State<'_, AppState>, year: i32, company: Option<String>) -> Result<DashboardData, String> {
    if company.is_none() {
        let cache = state.cache.lock().await;
        if let Some(data) = cache.as_ref() { return Ok(data.clone()); }
    }

    let _ = window.emit("splash-status", "Preparando filtro...");
    
    let target_raw_names = if let Some(comp_name) = company.as_deref() {
        if !comp_name.trim().is_empty() {
            let map = get_or_create_company_map(state.clone(), year).await?;
            map.get(comp_name).cloned() 
        } else { None }
    } else { None };

    if company.is_some() && target_raw_names.is_none() {
        return Err("Empresa não encontrada no cache.".to_string());
    }

    let db_guard = state.db.lock().await;
    let db = db_guard.as_ref().ok_or("Erro de conexão")?;
    
    let _ = window.emit("splash-status", "Buscando histórico de Produção...");
    let production = db.get_production_current(2020, target_raw_names.clone()).await.map_err(|e| e.to_string())?;

    let _ = window.emit("splash-status", "Buscando histórico de Comunicação...");
    let communication = db.get_communication_current(2020, target_raw_names).await.map_err(|e| e.to_string())?;

    let (last_update_ndd, last_update_iw) = tokio::join!(db.get_last_date("vw_NDD"), db.get_last_date("vw_IW_Main"));
    
    let total_equipments = production.iter().filter(|p| p.ano == Local::now().year()).map(|p| p.devices as i64).max().unwrap_or(0);
    let total_companies = if company.is_some() { 1 } else { 0 };

    let p = production;
    
    let (np, nc) = calculate_smart_projection("NDD", &p, &last_update_ndd);
    let (ip, ic) = calculate_smart_projection("IW", &p, &last_update_iw);

    Ok(DashboardData {
        production: p, communication, last_update_ndd, last_update_iw,
        projection: ProjectionData { ndd_pb: np, ndd_cor: nc, iw_pb: ip, iw_cor: ic },
        total_equipments, total_companies
    })
}

#[tauri::command]
async fn fetch_monitoring_data(window: Window, state: tauri::State<'_, AppState>) -> Result<MonitoringData, String> {
    {
        let cache = state.monitoring_cache.lock().await;
        if let Some(data) = cache.as_ref() { return Ok(data.clone()); }
    }
    let _ = window.emit("monitoring-status", "Analisando parque (MIF)...");
    let db_guard = state.db.lock().await;
    let db = db_guard.as_ref().ok_or("Banco desconectado")?;
    let result = db.get_monitoring_stats().await.map_err(|e| e.to_string())?;
    let mut cache = state.monitoring_cache.lock().await;
    *cache = Some(result.clone());
    Ok(result)
}

fn main() {
    tauri::Builder::default()
        .manage(AppState { 
            db: Mutex::new(None), cache: Mutex::new(None), 
            monitoring_cache: Mutex::new(None), companies_map_cache: Mutex::new(None),
            companies_cache_year: Mutex::new(None)
        })
        .invoke_handler(tauri::generate_handler![
            fetch_dashboard_data, fetch_companies, perform_initial_load, 
            fetch_full_history, finalize_startup, quit_app, fetch_monitoring_data,
            fetch_month_details_cmd, fetch_month_summary_cmd // <--- ESSENCIAL
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}