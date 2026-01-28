#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod models;
mod db;

use db::Database;
use models::{DashboardData, ProjectionData, ProductionRecord};
use tauri::{Window, Size, LogicalSize};
use tokio::sync::Mutex;
use chrono::{Datelike, Local};
use std::collections::HashMap;
use regex::Regex;
use tokio::time::{sleep, Duration};

struct AppState {
    db: Mutex<Option<Database>>,
    cache: Mutex<Option<DashboardData>>,
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
    current_year: i32,
    current_month: i32,
    current_day: i64,
    days_in_curr_month: i64
) -> (i64, i64) {
    let current_rec = records.iter().find(|r| 
        r.source == source_name && r.ano == current_year && r.mes == current_month
    );
    let (curr_pb, curr_cor) = match current_rec {
        Some(r) => (r.pb, r.cor),
        None => return (0, 0),
    };

    let day_divisor = if current_day == 0 { 1 } else { current_day };
    let rate_pb_linear = curr_pb as f64 / day_divisor as f64;
    let rate_cor_linear = curr_cor as f64 / day_divisor as f64;

    let history: Vec<&ProductionRecord> = records.iter().filter(|r| 
        r.source == source_name && r.mes == current_month && r.ano < current_year
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

    let use_historical = current_day <= 5 || (avg_daily_hist_pb > 0.0 && rate_pb_linear < (avg_daily_hist_pb * 0.6));
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

// --- COMANDOS TAURI ---

#[tauri::command]
async fn perform_initial_load(window: Window, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let _ = window.emit("splash-status", "Iniciando conexão segura...");
    sleep(Duration::from_millis(500)).await;

    let conn_str = "mssql://ndd_viewer:ioas%21%40%23ibusad%24%25%24%21%40asd3@192.168.41.22/Db_RPA?encrypt=true&trustServerCertificate=true";
    
    let mut db_guard = state.db.lock().await;
    if db_guard.is_none() {
        let db = Database::new(conn_str).await.map_err(|e| e.to_string())?;
        *db_guard = Some(db);
    }
    let db = db_guard.as_ref().unwrap();

    let start_date = "2020-01-01";

    let _ = window.emit("splash-status", "Baixando Histórico de Produção...");
    sleep(Duration::from_millis(300)).await;
    let production = db.get_production(start_date, None).await.map_err(|e| e.to_string())?;

    let _ = window.emit("splash-status", "Analisando Dados de Comunicação...");
    sleep(Duration::from_millis(300)).await;
    let communication = db.get_communication(start_date, None).await.map_err(|e| e.to_string())?;

    let _ = window.emit("splash-status", "Calculando estatísticas...");
    let (last_ndd, last_iw) = tokio::join!(db.get_last_date("vw_NDD"), db.get_last_date("vw_IW_Main"));

    let now = Local::now();
    let (ndd_pb, ndd_cor) = calculate_smart_projection("NDD", &production, now.year(), now.month() as i32, now.day() as i64, days_in_month(now.year(), now.month()));
    let (iw_pb, iw_cor) = calculate_smart_projection("IW", &production, now.year(), now.month() as i32, now.day() as i64, days_in_month(now.year(), now.month()));

    let data = DashboardData {
        production,
        communication,
        last_update_ndd: last_ndd,
        last_update_iw: last_iw,
        projection: ProjectionData { ndd_pb, ndd_cor, iw_pb, iw_cor },
    };

    let mut cache_guard = state.cache.lock().await;
    *cache_guard = Some(data);

    let _ = window.emit("splash-status", "Pronto!");
    sleep(Duration::from_millis(200)).await;

    Ok(())
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
async fn fetch_companies(state: tauri::State<'_, AppState>, source_filter: String) -> Result<Vec<String>, String> {
    let mut db_guard = state.db.lock().await;
    if db_guard.is_none() {
         let conn_str = "mssql://ndd_viewer:ioas%21%40%23ibusad%24%25%24%21%40asd3@192.168.41.22/Db_RPA?encrypt=true&trustServerCertificate=true";
         let db = Database::new(conn_str).await.map_err(|e| e.to_string())?;
         *db_guard = Some(db);
    }
    let db = db_guard.as_ref().unwrap();
    
    let raw_companies = db.get_raw_companies_with_data(&source_filter).await.map_err(|e| e.to_string())?;
    
    let mut groups: HashMap<String, String> = HashMap::new();
    for (raw, _) in raw_companies {
        let display = clean_name_for_display(&raw);
        if display.len() < 2 { continue; }
        let fingerprint = generate_fingerprint(&display);
        if fingerprint.is_empty() { continue; }
        groups.entry(fingerprint).and_modify(|c| { if display.len() > c.len() { *c = display.clone(); } }).or_insert(display);
    }
    let mut list: Vec<String> = groups.into_values().collect();
    list.sort();
    Ok(list)
}

#[tauri::command]
async fn fetch_dashboard_data(window: Window, state: tauri::State<'_, AppState>, company: Option<String>) -> Result<DashboardData, String> {
    if company.is_none() {
        let cache = state.cache.lock().await;
        if let Some(data) = cache.as_ref() {
            return Ok(data.clone());
        }
    }

    // AVISOS LIMPOS (SEM "FILTRANDO:")
    let _ = window.emit("splash-status", "Identificando empresa...");
    
    let db_guard = state.db.lock().await;
    let db = db_guard.as_ref().ok_or("Erro de conexão")?;

    let target = match company.as_deref() {
        Some(s) if !s.trim().is_empty() => {
             let f = generate_fingerprint(s);
             let all = db.get_raw_companies_with_data("Consolidado").await.map_err(|e| e.to_string())?;
             Some(all.into_iter().filter(|(r, _)| generate_fingerprint(&clean_name_for_display(r)) == f).map(|(r,_)| r).collect())
        },
        _ => None
    };
    
    // SEQUENCIAL COM DELAY E TEXTOS LIMPOS
    let _ = window.emit("splash-status", "Buscando Produção...");
    sleep(Duration::from_millis(250)).await;
    let production = db.get_production("2020-01-01", target.clone()).await.map_err(|e| e.to_string())?;

    let _ = window.emit("splash-status", "Verificando Comunicação...");
    sleep(Duration::from_millis(250)).await;
    let communication = db.get_communication("2020-01-01", target).await.map_err(|e| e.to_string())?;

    let _ = window.emit("splash-status", "Recalculando Projeções...");
    sleep(Duration::from_millis(200)).await;
    let (last_ndd, last_iw) = tokio::join!(
        db.get_last_date("vw_NDD"),
        db.get_last_date("vw_IW_Main")
    );
    
    let p = production;
    let now = Local::now();
    let (np, nc) = calculate_smart_projection("NDD", &p, now.year(), now.month() as i32, now.day() as i64, days_in_month(now.year(), now.month()));
    let (ip, ic) = calculate_smart_projection("IW", &p, now.year(), now.month() as i32, now.day() as i64, days_in_month(now.year(), now.month()));

    Ok(DashboardData {
        production: p,
        communication,
        last_update_ndd: last_ndd,
        last_update_iw: last_iw,
        projection: ProjectionData { ndd_pb: np, ndd_cor: nc, iw_pb: ip, iw_cor: ic }
    })
}

fn main() {
    tauri::Builder::default()
        .manage(AppState { db: Mutex::new(None), cache: Mutex::new(None) })
        .invoke_handler(tauri::generate_handler![
            fetch_dashboard_data, 
            fetch_companies, 
            perform_initial_load, 
            finalize_startup      
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}