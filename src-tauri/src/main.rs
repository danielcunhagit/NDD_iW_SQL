#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod models;
mod db;

use db::Database;
use models::{DashboardData, ProjectionData, ProductionRecord, MonitoringData};
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
    let db_date = NaiveDate::parse_from_str(db_last_date_str, "%Y-%m-%d")
        .unwrap_or_else(|_| Local::now().date_naive());
    
    let db_year = db_date.year();
    let db_month = db_date.month() as i32;
    let db_day = db_date.day() as i64;

    let current_rec = records.iter().find(|r| 
        r.source == source_name && r.ano == db_year && r.mes == db_month
    );

    let (curr_pb, curr_cor) = match current_rec {
        Some(r) => (r.pb, r.cor),
        None => return (0, 0),
    };

    let days_in_curr_month = days_in_month(db_year, db_month as u32);
    let day_divisor = if db_day == 0 { 1 } else { db_day };
    
    let rate_pb_linear = curr_pb as f64 / day_divisor as f64;
    let rate_cor_linear = curr_cor as f64 / day_divisor as f64;

    let history: Vec<&ProductionRecord> = records.iter().filter(|r| 
        r.source == source_name && r.mes == db_month && r.ano < db_year
    ).collect();

    let mut avg_daily_hist_pb = 0.0;
    let mut avg_daily_hist_cor = 0.0;

    if !history.is_empty() {
        let total_pb_hist: i64 = history.iter().map(|r| r.pb).sum();
        let total_cor_hist: i64 = history.iter().map(|r| r.cor).sum();
        let total_days_hist = (history.len() * 30) as f64; 
        if total_days_hist > 0.0 {
            avg_daily_hist_pb = total_pb_hist as f64 / total_days_hist;
            avg_daily_hist_cor = total_cor_hist as f64 / total_days_hist;
        }
    }

    let use_historical = db_day <= 5 || (avg_daily_hist_pb > 0.0 && rate_pb_linear < (avg_daily_hist_pb * 0.6));
    
    let final_rate_pb = if use_historical && avg_daily_hist_pb > 0.0 { avg_daily_hist_pb } else { rate_pb_linear };
    let final_rate_cor = if use_historical && avg_daily_hist_cor > 0.0 { avg_daily_hist_cor } else { rate_cor_linear };

    ((final_rate_pb * days_in_curr_month as f64) as i64, (final_rate_cor * days_in_curr_month as f64) as i64)
}

fn clean_name_for_display(raw: &str) -> String {
    let sanitized = raw.replace('\u{00A0}', " ");
    let mut name = sanitized.to_uppercase();
    let re_valid = Regex::new(r"[^A-Z0-9\s&-]").unwrap();
    name = re_valid.replace_all(&name, " ").to_string();
    let suffixes = [" S A", " SA", " S/A", " LTDA", " LIMITADA", " EIRELI", " ME", " EPP", " INC", " LLC", " COMERCIO E INDUSTRIA", " INDUSTRIA E COMERCIO", " COM E IND"];
    for suffix in suffixes {
        if name.ends_with(suffix) { name = name[..name.len() - suffix.len()].to_string(); }
    }
    Regex::new(r"\s+").unwrap().replace_all(&name, " ").trim().to_string()
}

fn generate_fingerprint(clean_name: &str) -> String {
    Regex::new(r"[^A-Z0-9]").unwrap().replace_all(clean_name, "").to_string()
}

async fn get_or_create_company_map(state: tauri::State<'_, AppState>) -> Result<HashMap<String, Vec<String>>, String> {
    {
        let cache_guard = state.companies_map_cache.lock().await;
        if let Some(map) = cache_guard.as_ref() { return Ok(map.clone()); }
    }
    let mut db_guard = state.db.lock().await;
    if db_guard.is_none() {
         let conn_str = "mssql://ndd_viewer:ioas%21%40%23ibusad%24%25%24%21%40asd3@192.168.41.22/Db_RPA?encrypt=true&trustServerCertificate=true";
         let db = Database::new(conn_str).await.map_err(|e| e.to_string())?;
         *db_guard = Some(db);
    }
    let db = db_guard.as_ref().unwrap();
    let raw_companies = db.get_raw_companies_with_data("Consolidado").await.map_err(|e| e.to_string())?;
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
    *cache_guard = Some(final_map.clone());
    Ok(final_map)
}

#[tauri::command]
fn quit_app() { std::process::exit(0); }

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

    // --- LOG SOLICITADO ---
    println!(">>> [DB DATA] Última NDD: {} | Última iW: {}", last_update_ndd, last_update_iw);
    // ----------------------

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

    let app_clone = app.clone(); 
    tokio::spawn(async move {
        let state = app_clone.state::<AppState>();
        let _ = get_or_create_company_map(state).await;
    });

    let _ = window.emit("splash-status", "Pronto!");
    sleep(Duration::from_millis(500)).await;
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
async fn fetch_companies(state: tauri::State<'_, AppState>, _source_filter: String) -> Result<Vec<String>, String> {
    let map = get_or_create_company_map(state).await?;
    let mut list: Vec<String> = map.keys().cloned().collect();
    list.sort();
    Ok(list)
}

#[tauri::command]
async fn fetch_dashboard_data(window: Window, state: tauri::State<'_, AppState>, company: Option<String>) -> Result<DashboardData, String> {
    if company.is_none() {
        let cache = state.cache.lock().await;
        if let Some(data) = cache.as_ref() { return Ok(data.clone()); }
    }

    let _ = window.emit("splash-status", "Preparando filtro...");
    
    let target_raw_names = if let Some(comp_name) = company.as_deref() {
        if !comp_name.trim().is_empty() {
            let map = get_or_create_company_map(state.clone()).await?;
            map.get(comp_name).cloned() 
        } else { None }
    } else { None };

    if company.is_some() && target_raw_names.is_none() {
        return Err("Empresa não encontrada no cache.".to_string());
    }

    let db_guard = state.db.lock().await;
    let db = db_guard.as_ref().ok_or("Erro de conexão")?;
    
    let _ = window.emit("splash-status", "Buscando histórico de Produção...");
    let start_year = 2020;
    
    let production = db.get_production_current(start_year, target_raw_names.clone()).await.map_err(|e| e.to_string())?;

    let _ = window.emit("splash-status", "Buscando histórico de Comunicação...");
    let communication = db.get_communication_current(start_year, target_raw_names).await.map_err(|e| e.to_string())?;

    let (last_update_ndd, last_update_iw) = tokio::join!(db.get_last_date("vw_NDD"), db.get_last_date("vw_IW_Main"));
    
    // --- LOG SOLICITADO NO FILTRO ---
    println!(">>> [DB DATA FILTER] Última NDD: {} | Última iW: {}", last_update_ndd, last_update_iw);
    // --------------------------------

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
            db: Mutex::new(None), 
            cache: Mutex::new(None), 
            monitoring_cache: Mutex::new(None),
            companies_map_cache: Mutex::new(None) 
        })
        .invoke_handler(tauri::generate_handler![
            fetch_dashboard_data, fetch_companies, perform_initial_load, 
            fetch_full_history, finalize_startup, quit_app, fetch_monitoring_data
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}