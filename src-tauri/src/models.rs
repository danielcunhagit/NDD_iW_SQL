use serde::{Serialize, Deserialize};

// Adicionei 'Clone' aqui
#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct ProductionRecord {
    pub source: String,
    pub ano: i32,
    pub mes: i32,
    pub pb: i64,
    pub cor: i64,
    pub devices: i32,
}

// Adicionei 'Clone' aqui
#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct CommunicationRecord {
    pub source: String,
    pub ano: i32,
    pub mes: i32,
    pub connected: i32,
    pub disconnected: i32,
}

// Adicionei 'Clone' aqui
#[derive(Debug, Serialize, Clone)]
pub struct DashboardData {
    pub production: Vec<ProductionRecord>,
    pub communication: Vec<CommunicationRecord>,
    pub last_update_ndd: String,
    pub last_update_iw: String,
    pub projection: ProjectionData,
}

// Adicionei 'Clone' aqui
#[derive(Debug, Serialize, Default, Clone)]
pub struct ProjectionData {
    pub ndd_pb: i64,
    pub ndd_cor: i64,
    pub iw_pb: i64,
    pub iw_cor: i64,
}