use serde::{Serialize, Deserialize};

// Estrutura para os dados de Produção
#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct ProductionRecord {
    pub ano: i32,
    pub mes: i32,
    pub pb: i64,
    pub cor: i64,
    pub devices: i32,
}

// Estrutura para os dados de Comunicação
#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct CommunicationRecord {
    pub ano: i32,
    pub mes: i32,
    pub connected: i32,
    pub disconnected: i32,
}

// Estrutura final enviada para o Frontend
#[derive(Debug, Serialize)]
pub struct DashboardData {
    pub production: Vec<ProductionRecord>,
    pub communication: Vec<CommunicationRecord>,
    pub last_update_ndd: String,
    pub last_update_iw: String,
    pub projection: ProjectionData,
}

#[derive(Debug, Serialize, Default)]
pub struct ProjectionData {
    pub ndd_pb: i64,
    pub ndd_cor: i64,
    pub iw_pb: i64,
    pub iw_cor: i64,
}