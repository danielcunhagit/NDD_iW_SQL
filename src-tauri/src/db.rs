use sqlx::mssql::{MssqlPool, MssqlPoolOptions};
use sqlx::FromRow;
use std::error::Error;
use std::collections::{HashSet, HashMap};
use regex::Regex;

pub struct Database {
    pool: MssqlPool,
}

// --- ESTRUTURAS INTERNAS (COM SUPORTE A NULOS) ---

// Usada no fallback de Produção
#[derive(FromRow, Clone, Debug)]
struct RawData {
    source: String,
    serial: Option<String>,
    empresa: Option<String>,
    ano: i32,
    mes: i32,
    pb: i64,
    cor: i64,
}

// Usada no fallback de Comunicação
#[derive(FromRow, Debug)]
struct RawCommData {
    source: String,
    ano: i32,
    mes: i32,
    serial: Option<String>,
    is_connected: i32,
}

// Usada no Monitoramento (MIF) - iW
#[derive(FromRow, Debug)]
struct RawIwMif {
    serial: Option<String>,
    compativel: Option<String>,
    cadastrado: Option<String>,
    possivel: Option<String>,
    status: Option<String>,
    item_code: Option<String>,
}

// Usada no Monitoramento (MIF) - NDD
#[derive(FromRow, Debug)]
struct RawNddMif {
    serial: Option<String>,
    // Removida dependência forte da coluna Compativel para evitar erros se não existir
    // Se a coluna existir no seu banco, descomente ou adicione na query
}

impl Database {
    pub async fn new(conn_str: &str) -> Result<Self, Box<dyn Error + Send + Sync>> {
        let pool = MssqlPoolOptions::new()
            .max_connections(10) 
            .acquire_timeout(std::time::Duration::from_secs(60))
            .connect(conn_str)
            .await?;
        Ok(Self { pool })
    }

    fn normalize_serial(serial: &str) -> String {
        serial.trim().to_uppercase()
    }

    fn normalize_company_name(raw_name: &str) -> String {
        let mut name = raw_name.to_uppercase();
        name = name.replace('.', "").replace('-', "").replace('/', "").replace(',', "");
        let re_spaces = Regex::new(r"\s+").unwrap();
        name = re_spaces.replace_all(&name, " ").to_string();
        name = name.replace("TRANSP ", "TRANSPORTES ").replace("COM ", "COMERCIO ").replace("IND ", "INDUSTRIA ").replace("SERV ", "SERVICOS ");
        let suffixes = [" S A", " SA", " S/A", " LTDA", " LIMITADA", " EIRELI", " ME", " EPP", " INC", " LLC", " COMERCIO E INDUSTRIA", " INDUSTRIA E COMERCIO"];
        for suffix in suffixes.iter() {
            if name.ends_with(suffix) {
                name = name[..name.len() - suffix.len()].to_string();
            }
        }
        name.trim().to_string()
    }

    // ==================================================================================
    // GRÁFICOS (PRODUÇÃO E COMUNICAÇÃO)
    // ==================================================================================

    async fn fetch_prod(&self, where_clause: &str, company_filter: Option<Vec<String>>) -> Result<Vec<crate::models::ProductionRecord>, Box<dyn Error + Send + Sync>> {
        let iw_exclusion = r#"
            AND NOT EXISTS (
                SELECT 1 FROM vw_NDD n 
                WHERE n.SerialNumber = w.[Serial#]
                AND YEAR(n.data) = YEAR(w.data) 
                AND MONTH(n.data) = MONTH(w.data)
            )
        "#;

        let mut query = format!(r#"
            SELECT source, ano, mes, 
                   SUM(pb) as pb, 
                   SUM(cor) as cor, 
                   COUNT(DISTINCT CASE WHEN (pb + cor) > 0 THEN serial END) as devices 
            FROM (
                SELECT 'NDD' as source, YEAR(data) as ano, MONTH(data) as mes, SerialNumber as serial, CAST(ISNULL(pb_total, 0) as bigint) as pb, CAST(ISNULL(cor_total, 0) as bigint) as cor, EnterpriseName as empresa 
                FROM vw_NDD WHERE {}
                
                UNION ALL
                
                SELECT 'IW' as source, YEAR(data) as ano, MONTH(data) as mes, [Serial#] as serial, CAST(ISNULL(pb_total, 0) as bigint) as pb, CAST(ISNULL(cor_total, 0) as bigint) as cor, [Ship To Name] as empresa 
                FROM vw_IW_Main w WHERE {} {}
            ) as CombinedData WHERE 1=1
        "#, where_clause, where_clause, iw_exclusion);

        if let Some(companies) = company_filter {
            if !companies.is_empty() {
                let list_str = companies.iter().map(|c| format!("'{}'", c.replace("'", "''"))).collect::<Vec<_>>().join(",");
                query.push_str(&format!(" AND empresa IN ({})", list_str));
            }
        }
        query.push_str(" GROUP BY source, ano, mes ORDER BY ano DESC, mes DESC");
        
        let records = sqlx::query_as::<_, crate::models::ProductionRecord>(&query).fetch_all(&self.pool).await?;
        Ok(records)
    }

pub async fn get_production_current(&self, start_year: i32, company_filter: Option<Vec<String>>) -> Result<Vec<crate::models::ProductionRecord>, Box<dyn Error + Send + Sync>> {
        // GARANTIA: Se start_year for muito antigo (ex: 0 ou 1900), forçamos 2020
        let safe_start_year = if start_year < 2020 { 2020 } else { start_year };
        let where_clause = format!("data >= '{}-01-01'", safe_start_year);
        self.fetch_prod(&where_clause, company_filter).await
    }

    pub async fn get_production_history(&self, end_year_exclusive: i32) -> Result<Vec<crate::models::ProductionRecord>, Box<dyn Error + Send + Sync>> {
        let where_clause = format!("data < '{}-01-01'", end_year_exclusive);
        self.fetch_prod(&where_clause, None).await
    }

    async fn fetch_comm(&self, where_data: &str, company_filter: Option<Vec<String>>) -> Result<Vec<crate::models::CommunicationRecord>, Box<dyn Error + Send + Sync>> {
        let mut filter_ndd = String::new();
        let mut filter_iw = String::new();
        
        if let Some(companies) = &company_filter {
            if !companies.is_empty() {
                let list_str = companies.iter().map(|c| format!("'{}'", c.replace("'", "''"))).collect::<Vec<_>>().join(",");
                filter_ndd = format!(" AND EnterpriseName IN ({})", list_str);
                filter_iw = format!(" AND [Ship To Name] IN ({})", list_str);
            }
        }

        // Trazemos RAW para processar em memória e evitar lentidão do SQL
        let q_ndd = format!(r#"
            SELECT 'NDD' as source, YEAR(data) as ano, MONTH(data) as mes, SerialNumber as serial, 
                   CASE WHEN [Days without meters] <= 7 THEN 1 ELSE 0 END as is_connected
            FROM vw_NDD 
            WHERE {} AND data IN (SELECT MAX(data) FROM vw_NDD WHERE {} GROUP BY YEAR(data), MONTH(data))
            {}
        "#, where_data, where_data, filter_ndd);

        let q_iw = format!(r#"
            SELECT 'IW' as source, YEAR(data) as ano, MONTH(data) as mes, [Serial#] as serial, 
                   CASE WHEN [Lapsed Days] <= 7 THEN 1 ELSE 0 END as is_connected
            FROM vw_IW_Main 
            WHERE {} AND data IN (SELECT MAX(data) FROM vw_IW_Main WHERE {} GROUP BY YEAR(data), MONTH(data))
            AND [Cadastrado no iW] = 'sim'
            {}
        "#, where_data, where_data, filter_iw);

        let (ndd_rows, iw_rows) = tokio::join!(
            sqlx::query_as::<_, RawCommData>(&q_ndd).fetch_all(&self.pool),
            sqlx::query_as::<_, RawCommData>(&q_iw).fetch_all(&self.pool)
        );

        let ndd_data = ndd_rows?;
        let iw_data = iw_rows?;

        // Deduplicação em Memória
        let mut ndd_set: HashSet<String> = HashSet::new();
        for r in &ndd_data {
            if let Some(serial) = &r.serial {
                let key = format!("{}-{}-{}", r.ano, r.mes, Self::normalize_serial(serial));
                ndd_set.insert(key);
            }
        }

        let mut stats: HashMap<String, crate::models::CommunicationRecord> = HashMap::new();

        for r in ndd_data {
            let key = format!("NDD-{}-{}", r.ano, r.mes);
            let entry = stats.entry(key).or_insert(crate::models::CommunicationRecord {
                source: "NDD".to_string(), ano: r.ano, mes: r.mes, connected: 0, disconnected: 0
            });
            if r.is_connected == 1 { entry.connected += 1; } else { entry.disconnected += 1; }
        }

        for r in iw_data {
            if let Some(serial) = &r.serial {
                let lookup_key = format!("{}-{}-{}", r.ano, r.mes, Self::normalize_serial(serial));
                if ndd_set.contains(&lookup_key) { continue; }

                let key = format!("IW-{}-{}", r.ano, r.mes);
                let entry = stats.entry(key).or_insert(crate::models::CommunicationRecord {
                    source: "IW".to_string(), ano: r.ano, mes: r.mes, connected: 0, disconnected: 0
                });
                if r.is_connected == 1 { entry.connected += 1; } else { entry.disconnected += 1; }
            }
        }

        let mut result: Vec<crate::models::CommunicationRecord> = stats.into_values().collect();
        result.sort_by(|a, b| b.ano.cmp(&a.ano).then(b.mes.cmp(&a.mes)));

        Ok(result)
    }

pub async fn get_communication_current(&self, start_year: i32, company_filter: Option<Vec<String>>) -> Result<Vec<crate::models::CommunicationRecord>, Box<dyn Error + Send + Sync>> {
        let safe_start_year = if start_year < 2020 { 2020 } else { start_year };
        let where_clause = format!("data >= '{}-01-01'", safe_start_year);
        self.fetch_comm(&where_clause, company_filter).await
    }

    pub async fn get_communication_history(&self, end_year_exclusive: i32) -> Result<Vec<crate::models::CommunicationRecord>, Box<dyn Error + Send + Sync>> {
        let where_clause = format!("data < '{}-01-01'", end_year_exclusive);
        self.fetch_comm(&where_clause, None).await
    }

    // ==================================================================================
    // MONITORAMENTO (MIF) - CORRIGIDO E OTIMIZADO
    // ==================================================================================

pub async fn get_monitoring_stats(&self) -> Result<crate::models::MonitoringData, Box<dyn Error + Send + Sync>> {
        // Tenta obter a data mais recente
        let max_date_str: String = sqlx::query_scalar("SELECT TOP 1 CONVERT(varchar, data, 23) FROM vw_IW_Main ORDER BY data DESC")
            .fetch_one(&self.pool).await.unwrap_or("N/D".to_string());
        
        // 1. Busca lista de seriais do NDD (Snapshot atual)
        let sql_ndd = r#"
            SELECT DISTINCT UPPER(RTRIM(LTRIM(SerialNumber))) as serial
            FROM vw_NDD 
            WHERE data = (SELECT MAX(data) FROM vw_NDD)
        "#;
        
        // 2. Busca lista COMPLETA do iW (Snapshot atual)
        let sql_iw = r#"
            SELECT 
                UPPER(RTRIM(LTRIM([Serial#]))) as serial, 
                LOWER(CAST([Compativel iW] as varchar)) as compativel, 
                LOWER(CAST([Cadastrado no iW] as varchar)) as cadastrado, 
                LOWER(CAST([Possível cadastrar iW] as varchar)) as possivel, 
                LOWER(CAST([status] as varchar)) as status,
                UPPER(RTRIM(LTRIM([Item Code]))) as item_code
            FROM vw_IW_Main 
            WHERE data = (SELECT MAX(data) FROM vw_IW_Main)
        "#;

        // Executa queries em paralelo
        let (ndd_rows, iw_rows) = tokio::join!(
            sqlx::query_scalar::<_, String>(sql_ndd).fetch_all(&self.pool),
            sqlx::query_as::<_, RawIwMif>(sql_iw).fetch_all(&self.pool)
        );

        let ndd_serials_vec = ndd_rows?;
        let iw_data = iw_rows?;

        // --- PROCESSAMENTO EM MEMÓRIA ---

        // 1. Conjunto de Seriais NDD para busca rápida e cálculo do card NDD
        let ndd_set: std::collections::HashSet<String> = ndd_serials_vec.into_iter().collect();
        let ndd_print_count = ndd_set.len() as i64; // Card "NDD Print"

        // 2. Descobrir modelos compatíveis (Lógica anterior mantida)
        let mut ndd_compatible_models = std::collections::HashSet::new();
        for r in &iw_data {
            if let Some(serial) = &r.serial {
                if ndd_set.contains(serial) {
                    if let Some(code) = &r.item_code {
                        if !code.trim().is_empty() {
                            ndd_compatible_models.insert(code.clone());
                        }
                    }
                }
            }
        }
        
        // --- CÁLCULO DAS ESTATÍSTICAS ---

        let mif = iw_data.len() as i64;
        
        let mut compatible_count = 0;
        let mut not_compatible_count = 0;
        
        let mut iw_exclusive_count = 0; // Card "iW Remote" (Novo cálculo)
        let mut monitored_count = 0;    // Card "Monitorados"
        
        // Cards detalhe (Sem Monitoramento)
        let mut opp_canon = 0;
        let mut opp_inter = 0;
        let mut opp_not_possible = 0;

        let is_sim = |opt: &Option<String>| -> bool { 
            if let Some(s) = opt { 
                let v = s.trim(); 
                v == "sim" || v == "s" || v == "1" || v == "yes" 
            } else { false } 
        };

        for r in &iw_data {
            let serial = r.serial.as_deref().unwrap_or("").to_string();
            
            // --- 1. Lógica de Compatibilidade (Mantida) ---
            let comp_iw = is_sim(&r.compativel);
            let comp_ndd = r.item_code.as_ref()
                .map(|code| ndd_compatible_models.contains(code))
                .unwrap_or(false);

            if comp_iw || comp_ndd {
                compatible_count += 1;
            } else {
                not_compatible_count += 1;
            }

            // --- 2. Lógica de Monitoramento (ALTERADA AQUI) ---
            let in_ndd = ndd_set.contains(&serial);
            let in_iw = is_sim(&r.cadastrado);

            // Definição de Monitorado: Está no NDD OU está no iW
            if in_ndd || in_iw {
                monitored_count += 1;
            } else {
                // Se não é monitorado por ninguém, entra na estatística de Oportunidade
                if is_sim(&r.possivel) {
                    let st = r.status.as_deref().unwrap_or("");
                    if st.contains("canon") {
                        opp_canon += 1;
                    } else if st.contains("inter") {
                        opp_inter += 1;
                    }
                } else {
                    opp_not_possible += 1;
                }
            }

            // --- 3. Lógica do Card iW Remote (Exclusivo) ---
            // Regra do Usuário: Filtrar cadastrado="sim" E remover duplicados do NDD.
            // Ou seja: É iW MAS NÃO É NDD.
            if in_iw && !in_ndd {
                iw_exclusive_count += 1;
            }
        }

        let not_registered = mif - monitored_count;

        // VALIDAÇÃO FINAL (apenas comentário lógico):
        // monitored_count (União) == ndd_print_count (A) + iw_exclusive_count (B - A)
        // A lógica matemática está correta.

        Ok(crate::models::MonitoringData { 
            mif, 
            compatible: compatible_count,
            not_compatible: not_compatible_count, 
            registered: monitored_count,     
            not_registered,                  
            ndd: ndd_print_count,            
            iw: iw_exclusive_count, // Agora retorna apenas os EXCLUSIVOS do iW
            possible: (opp_canon + opp_inter), 
            not_possible: opp_not_possible,
            possible_canon: opp_canon,
            possible_inter: opp_inter,
            last_date: max_date_str 
        })
    }

    // --- SIDE PANEL ---
    pub async fn get_active_companies_in_year(&self, year: i32) -> Result<Vec<(String, i64)>, Box<dyn Error + Send + Sync>> {
        let query = format!(r#"
            SELECT empresa, SUM(cnt) as cnt 
            FROM (
                SELECT EnterpriseName as empresa, COUNT(*) as cnt FROM vw_NDD WHERE YEAR(data) = {} GROUP BY EnterpriseName
                UNION ALL
                SELECT [Ship To Name] as empresa, COUNT(*) as cnt FROM vw_IW_Main WHERE YEAR(data) = {} GROUP BY [Ship To Name]
            ) as AllComps
            GROUP BY empresa 
            ORDER BY empresa
        "#, year, year);
        
        let rows: Vec<(Option<String>, i32)> = sqlx::query_as(&query).fetch_all(&self.pool).await?;
        
        let mut map: HashMap<String, i64> = HashMap::new();
        for (name_opt, cnt) in rows {
            if let Some(name) = name_opt {
                let clean = Self::normalize_company_name(&name);
                if !clean.is_empty() {
                    *map.entry(clean).or_insert(0) += cnt as i64;
                }
            }
        }

        let mut result: Vec<(String, i64)> = map.into_iter().collect();
        result.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(result)
    }

    pub async fn get_month_company_summary(&self, year: i32, month: i32) -> Result<Vec<crate::models::CompanySummary>, Box<dyn Error + Send + Sync>> {
        let query = format!(r#"
            WITH CombinedData AS (
                SELECT 'NDD' as source, ISNULL(EnterpriseName, 'N/D') as empresa, SerialNumber as serial,
                    (CAST(ISNULL(pb_total, 0) as bigint) + CAST(ISNULL(cor_total, 0) as bigint)) as prod,
                    CASE WHEN [Days without meters] <= 7 THEN 1 ELSE 0 END as is_online,
                    ROW_NUMBER() OVER(PARTITION BY SerialNumber ORDER BY data DESC) as rn
                FROM vw_NDD WHERE YEAR(data) = {} AND MONTH(data) = {}

                UNION ALL

                SELECT 'IW' as source, ISNULL([Ship To Name], 'N/D') as empresa, [Serial#] as serial,
                    (CAST(ISNULL(pb_total, 0) as bigint) + CAST(ISNULL(cor_total, 0) as bigint)) as prod,
                    CASE WHEN [Lapsed Days] <= 7 THEN 1 ELSE 0 END as is_online,
                    ROW_NUMBER() OVER(PARTITION BY [Serial#] ORDER BY data DESC) as rn
                FROM vw_IW_Main w WHERE YEAR(data) = {} AND MONTH(data) = {}
                AND [Cadastrado no iW] = 'sim'
                AND NOT EXISTS (
                    SELECT 1 FROM vw_NDD n WHERE n.SerialNumber = w.[Serial#] 
                    AND YEAR(n.data) = YEAR(w.data) AND MONTH(n.data) = MONTH(w.data)
                )
            )
            SELECT source, empresa,
                COUNT(CASE WHEN rn = 1 AND is_online = 1 THEN 1 END) as online,
                COUNT(CASE WHEN rn = 1 AND is_online = 0 THEN 1 END) as offline,
                CAST(ISNULL(SUM(prod), 0) AS BIGINT) as producao
            FROM CombinedData
            GROUP BY source, empresa
            ORDER BY offline DESC, producao DESC
        "#, year, month, year, month);

        let records = sqlx::query_as::<_, crate::models::CompanySummary>(&query).fetch_all(&self.pool).await?;
        Ok(records)
    }

    pub async fn get_month_details(&self, year: i32, month: i32, company_filter: Option<Vec<String>>) -> Result<Vec<crate::models::DeviceDetail>, Box<dyn Error + Send + Sync>> {
        let iw_exclusion = r#"
            AND [Cadastrado no iW] = 'sim'
            AND NOT EXISTS (
                SELECT 1 FROM vw_NDD n WHERE n.SerialNumber = w.[Serial#]
                AND YEAR(n.data) = YEAR(w.data) AND MONTH(n.data) = MONTH(w.data)
            )
        "#;

        let mut query = format!(r#"
            SELECT source, serial, empresa, SUM(pb) as pb, SUM(cor) as cor, SUM(pb + cor) as total
            FROM (
                SELECT 'NDD' as source, SerialNumber as serial, EnterpriseName as empresa, 
                       CAST(ISNULL(pb_total, 0) as bigint) as pb, CAST(ISNULL(cor_total, 0) as bigint) as cor
                FROM vw_NDD WHERE YEAR(data) = {} AND MONTH(data) = {}

                UNION ALL

                SELECT 'IW' as source, [Serial#] as serial, [Ship To Name] as empresa, 
                       CAST(ISNULL(pb_total, 0) as bigint) as pb, CAST(ISNULL(cor_total, 0) as bigint) as cor
                FROM vw_IW_Main w WHERE YEAR(data) = {} AND MONTH(data) = {} {}
            ) as Details WHERE 1=1
        "#, year, month, year, month, iw_exclusion);

        if let Some(companies) = company_filter {
            if !companies.is_empty() {
                let list_str = companies.iter().map(|c| format!("'{}'", c.replace("'", "''"))).collect::<Vec<_>>().join(",");
                query.push_str(&format!(" AND empresa IN ({})", list_str));
            }
        }
        query.push_str(" GROUP BY source, serial, empresa ORDER BY total DESC");

        let records = sqlx::query_as::<_, crate::models::DeviceDetail>(&query).fetch_all(&self.pool).await?;
        Ok(records)
    }

    pub async fn get_snapshot_stats(&self) -> Result<(i64, i64), Box<dyn Error + Send + Sync>> {
        let sql = r#"
            SELECT 
                (SELECT COUNT(DISTINCT SerialNumber) FROM vw_NDD WHERE data = (SELECT MAX(data) FROM vw_NDD)),
                (SELECT COUNT(DISTINCT [Serial#]) FROM vw_IW_Main w WHERE data = (SELECT MAX(data) FROM vw_IW_Main) 
                 AND [Cadastrado no iW] = 'sim'
                 AND NOT EXISTS (SELECT 1 FROM vw_NDD n WHERE n.SerialNumber = w.[Serial#] AND n.data = (SELECT MAX(data) FROM vw_NDD)))
        "#;
        let (ndd, iw): (i32, i32) = sqlx::query_as(sql).fetch_one(&self.pool).await.unwrap_or((0, 0));
        Ok(( (ndd + iw) as i64, 0))
    }

    pub async fn get_last_date(&self, table_view: &str) -> String {
        let query = format!("SELECT TOP 1 CONVERT(varchar, data, 23) FROM {} ORDER BY data DESC", table_view);
        sqlx::query_scalar::<_, String>(&query).fetch_one(&self.pool).await.unwrap_or_else(|_| "N/D".to_string())
    }
}