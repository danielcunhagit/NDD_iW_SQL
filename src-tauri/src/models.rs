use serde::{Serialize, Deserialize};

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct ProductionRecord {
    pub source: String,
    pub ano: i32,
    pub mes: i32,
    pub pb: i64,
    pub cor: i64,
    pub devices: i32,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct CommunicationRecord {
    pub source: String,
    pub ano: i32,
    pub mes: i32,
    pub connected: i32,
    pub disconnected: i32,
}

#[derive(Debug, Serialize, Clone)]
pub struct DashboardData {
    pub production: Vec<ProductionRecord>,
    pub communication: Vec<CommunicationRecord>,
    pub last_update_ndd: String,
    pub last_update_iw: String,
    pub projection: ProjectionData,
    pub total_equipments: i64,
    pub total_companies: i64,
}

#[derive(Debug, Serialize, Default, Clone)]
pub struct ProjectionData {
    pub ndd_pb: i64,
    pub ndd_cor: i64,
    pub iw_pb: i64,
    pub iw_cor: i64,
}

#[derive(Debug, Serialize, Default, Clone)]
pub struct MonitoringData {
    pub mif: i64,
    pub compatible: i64,
    pub not_compatible: i64,
    pub registered: i64,
    pub not_registered: i64,
    pub ndd: i64,
    pub iw: i64,
    pub possible: i64,
    pub not_possible: i64,
    pub possible_canon: i64,
    pub possible_inter: i64,
    pub last_date: String,
}

#[derive(sqlx::FromRow)]
pub struct IwRawData {
    pub serial: String,
    pub compativel: Option<String>,
    pub cadastrado: Option<String>,
    pub possivel: Option<String>,
    pub status: Option<String>,
}

// Detalhes Individuais (Quando filtra uma empresa)
#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct DeviceDetail {
    pub source: String,
    pub serial: String,
    pub empresa: Option<String>,
    pub pb: i64,
    pub cor: i64,
    pub total: i64,
}

// Resumo por Empresa (Visão Geral - Req 4 e 5)
#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct CompanySummary {
    pub source: String,
    pub empresa: String,
    pub online: i32,  // <= 7 dias
    pub offline: i32, // > 7 dias
    pub producao: i64,
}