use serde::{Serialize, Deserialize};

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct ProductionRecord {
    pub source: String,
    pub ano: i32,
    pub mes: i32,
    pub pb: i64,
    pub cor: i64,
    pub devices: i64, // CORRIGIDO: i64 para evitar panic de memória
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct CommunicationRecord {
    pub source: String,
    pub ano: i32,
    pub mes: i32,
    pub connected: i64, // CORRIGIDO: i64
    pub disconnected: i64, // CORRIGIDO: i64
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DashboardData {
    pub production: Vec<ProductionRecord>,
    pub communication: Vec<CommunicationRecord>,
    pub last_update_ndd: String,
    pub last_update_iw: String,
    pub projection: ProjectionData,
    pub total_equipments: i64,
    pub total_companies: i64,
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
pub struct ProjectionData {
    pub ndd_pb: i64,
    pub ndd_cor: i64,
    pub iw_pb: i64,
    pub iw_cor: i64,
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
#[serde(default)] // <--- MÁGICA: Preenche com zero o que faltar no cache antigo!
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

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct DeviceDetail {
    pub source: String,
    pub serial: String,
    pub empresa: Option<String>,
    pub pb: i64,
    pub cor: i64,
    pub total: i64,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct CompanySummary {
    pub source: String,
    pub empresa: String,
    pub online: i64,  // CORRIGIDO: i64
    pub offline: i64, // CORRIGIDO: i64
    pub producao: i64,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, sqlx::FromRow, Clone)]
pub struct RawIwMif {
    pub serial: Option<String>,
    pub compativel: Option<String>,
    pub cadastrado: Option<String>,
    pub possivel: Option<String>,
    pub status: Option<String>,
    pub item_code: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)] // <--- ADICIONE O Default AQUI
#[serde(default)] // <--- MÁGICA DE COMPATIBILIDADE AQUI TAMBÉM
pub struct MonitoringCompanySummary {
    pub empresa: String,
    pub mif: i64,
    pub compatible: i64,
    pub not_compatible: i64,
    pub registered: i64,
    pub not_registered: i64,
    pub ndd: i64,
    pub iw: i64,
    pub possible_canon: i64,
    pub possible_inter: i64,
    pub not_possible: i64,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, sqlx::FromRow, Clone)]
#[allow(non_snake_case)]
pub struct NdrRawRow {
    pub PrinterDeviceID: Option<String>,
    pub EnterpriseName_ref: Option<String>,
    pub EnterpriseID: Option<String>,
    pub EnterpriseName: Option<String>,
    pub SiteID: Option<String>,
    pub SiteName: Option<String>,
    pub SiteDivisionName: Option<String>,
    pub PrinterName: Option<String>,
    pub BrandName: Option<String>,
    pub ModelName: Option<String>,
    pub SerialNumber: Option<String>,
    pub AddressName: Option<String>,
    pub Location: Option<String>,
    pub ContactData: Option<String>,
    pub LastNSLDate: Option<String>,
    pub Passivel_de_Monitoramento: Option<String>,
    pub Motivo_Nao_Monitoramento: Option<String>,
    pub Days_without_meters: Option<i32>,
    pub primaryKey: Option<String>,
    pub SerialCountedChar: Option<String>,
    pub FirstDateTimeRead: Option<String>,
    pub LastDateTimeRead: Option<String>,
    pub start_101: Option<i64>, pub end_101: Option<i64>,
    pub start_102: Option<i64>, pub end_102: Option<i64>,
    pub start_108: Option<i64>, pub end_108: Option<i64>,
    pub start_112: Option<i64>, pub end_112: Option<i64>,
    pub start_113: Option<i64>, pub end_113: Option<i64>,
    pub start_229: Option<i64>, pub end_229: Option<i64>,
    pub start_230: Option<i64>, pub end_230: Option<i64>,
    pub start_321: Option<i64>, pub end_321: Option<i64>,
    pub start_322: Option<i64>, pub end_322: Option<i64>,
    pub pb_peq: Option<i64>, pub pb_grande: Option<i64>, pub pb_total: Option<i64>,
    pub cor_peq: Option<i64>, pub cor_grande: Option<i64>, pub cor_total: Option<i64>,
    pub total: Option<i64>,
    pub data: Option<String>,
    pub Gestao_de_Suprimentos: Option<String>,
}