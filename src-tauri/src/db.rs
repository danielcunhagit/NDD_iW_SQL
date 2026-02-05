use sqlx::mssql::{MssqlPool, MssqlPoolOptions};
use std::error::Error;
use std::collections::{HashSet, HashMap};
use regex::Regex;

pub struct Database {
    pool: MssqlPool,
}

impl Database {
    pub async fn new(conn_str: &str) -> Result<Self, Box<dyn Error + Send + Sync>> {
        let pool = MssqlPoolOptions::new()
            .max_connections(10) 
            .acquire_timeout(std::time::Duration::from_secs(5)) 
            .connect(conn_str)
            .await?;
        Ok(Self { pool })
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

    // --- FETCH PROD (MANTIDO COM A REGRA DE DEDUPLICAÇÃO iW/NDD) ---
    async fn fetch_prod(&self, where_clause: &str, company_filter: Option<Vec<String>>) -> Result<Vec<crate::models::ProductionRecord>, Box<dyn Error + Send + Sync>> {
        // REGRA: Remover iW se existir NDD com produção > 0 no mesmo período
        let iw_exclusion = r#"
            AND NOT EXISTS (
                SELECT 1 FROM vw_NDD n 
                WHERE n.SerialNumber = w.[Serial#] 
                AND YEAR(n.data) = YEAR(w.data) 
                AND MONTH(n.data) = MONTH(w.data)
                AND (ISNULL(n.pb_total, 0) + ISNULL(n.cor_total, 0)) > 0
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
        let where_clause = format!("data >= '{}-01-01'", start_year);
        self.fetch_prod(&where_clause, company_filter).await
    }

    pub async fn get_production_history(&self, end_year_exclusive: i32) -> Result<Vec<crate::models::ProductionRecord>, Box<dyn Error + Send + Sync>> {
        let where_clause = format!("data < '{}-01-01'", end_year_exclusive);
        self.fetch_prod(&where_clause, None).await
    }

    // --- FETCH COMM ATUALIZADO: FILTRO POR DATA MÁXIMA MENSAL ---
    async fn fetch_comm(&self, where_clause: &str, company_filter: Option<Vec<String>>) -> Result<Vec<crate::models::CommunicationRecord>, Box<dyn Error + Send + Sync>> {
        // Correção: Adicionado "WHERE data IN (SELECT MAX(data)...)" para pegar apenas o retrato do fim do mês
        // NDD: [Days without meters] <= 7 -> ON
        // iW:  [Lapsed Days] <= 7 -> ON
        let mut query = format!(r#"
            SELECT source, ano, mes, 
                   COUNT(DISTINCT CASE WHEN is_connected = 1 THEN serial END) as connected, 
                   COUNT(DISTINCT CASE WHEN is_connected = 0 THEN serial END) as disconnected 
            FROM (
                SELECT 'NDD' as source, YEAR(data) as ano, MONTH(data) as mes, SerialNumber as serial, EnterpriseName as empresa, 
                       CASE WHEN [Days without meters] <= 7 THEN 1 ELSE 0 END as is_connected 
                FROM vw_NDD 
                WHERE data IN (SELECT MAX(data) FROM vw_NDD GROUP BY YEAR(data), MONTH(data))
                AND {}

                UNION ALL

                SELECT 'IW' as source, YEAR(data) as ano, MONTH(data) as mes, [Serial#] as serial, [Ship To Name] as empresa, 
                       CASE WHEN [Lapsed Days] <= 7 THEN 1 ELSE 0 END as is_connected 
                FROM vw_IW_Main 
                WHERE data IN (SELECT MAX(data) FROM vw_IW_Main GROUP BY YEAR(data), MONTH(data))
                AND {}
            ) as CommData WHERE 1=1
        "#, where_clause, where_clause);

        if let Some(companies) = company_filter {
            if !companies.is_empty() {
                let list_str = companies.iter().map(|c| format!("'{}'", c.replace("'", "''"))).collect::<Vec<_>>().join(",");
                query.push_str(&format!(" AND empresa IN ({})", list_str));
            }
        }
        query.push_str(" GROUP BY source, ano, mes ORDER BY ano DESC, mes DESC");
        
        let records = sqlx::query_as::<_, crate::models::CommunicationRecord>(&query).fetch_all(&self.pool).await?;
        Ok(records)
    }

    pub async fn get_communication_current(&self, start_year: i32, company_filter: Option<Vec<String>>) -> Result<Vec<crate::models::CommunicationRecord>, Box<dyn Error + Send + Sync>> {
        let where_clause = format!("data >= '{}-01-01'", start_year);
        self.fetch_comm(&where_clause, company_filter).await
    }

    pub async fn get_communication_history(&self, end_year_exclusive: i32) -> Result<Vec<crate::models::CommunicationRecord>, Box<dyn Error + Send + Sync>> {
        let where_clause = format!("data < '{}-01-01'", end_year_exclusive);
        self.fetch_comm(&where_clause, None).await
    }

    pub async fn get_snapshot_stats(&self) -> Result<(i64, i64), Box<dyn Error + Send + Sync>> {
        let sql_eqp = r#"
            SELECT 
                ISNULL((SELECT COUNT(DISTINCT SerialNumber) FROM vw_NDD WHERE data = (SELECT MAX(data) FROM vw_NDD)), 0)
                + 
                ISNULL((SELECT COUNT(DISTINCT [Serial#]) FROM vw_IW_Main WHERE data = (SELECT MAX(data) FROM vw_IW_Main) 
                 AND [Serial#] NOT IN (SELECT DISTINCT SerialNumber FROM vw_NDD WHERE data = (SELECT MAX(data) FROM vw_NDD))), 0)
        "#;
        let total_equipments: i64 = sqlx::query_scalar(sql_eqp).fetch_one(&self.pool).await.unwrap_or(0);

        let sql_companies = "SELECT DISTINCT EnterpriseName FROM vw_NDD WHERE data = (SELECT MAX(data) FROM vw_NDD)";
        let companies_raw: Vec<Option<String>> = sqlx::query_scalar(sql_companies).fetch_all(&self.pool).await?;

        let mut unique_companies: HashSet<String> = HashSet::new();
        for c in companies_raw {
            if let Some(name) = c {
                if name.trim().len() > 1 { unique_companies.insert(Self::normalize_company_name(&name)); }
            }
        }
        Ok((total_equipments, unique_companies.len() as i64))
    }

    pub async fn get_last_date(&self, table_view: &str) -> String {
        let query = format!("SELECT TOP 1 CONVERT(varchar, data, 23) FROM {} ORDER BY data DESC", table_view);
        sqlx::query_scalar::<_, String>(&query).fetch_one(&self.pool).await.unwrap_or_else(|_| "N/D".to_string())
    }

    pub async fn get_raw_companies_with_data(&self, _source_filter: &str) -> Result<Vec<(String, i64)>, Box<dyn Error + Send + Sync>> {
        let query = String::from(r#"
            SELECT empresa, SUM(cnt) as cnt 
            FROM (
                SELECT EnterpriseName as empresa, COUNT(*) as cnt FROM vw_NDD GROUP BY EnterpriseName
                UNION ALL
                SELECT [Ship To Name] as empresa, COUNT(*) as cnt FROM vw_IW_Main GROUP BY [Ship To Name]
            ) as AllComps
            GROUP BY empresa 
            ORDER BY empresa
        "#);
        let rows: Vec<(String, i32)> = sqlx::query_as(&query).fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|(n, c)| (n, c as i64)).collect())
    }

    pub async fn get_monitoring_stats(&self) -> Result<crate::models::MonitoringData, Box<dyn Error + Send + Sync>> {
        let max_date_str: String = sqlx::query_scalar("SELECT CONVERT(varchar, MAX(data), 23) FROM vw_IW_Main").fetch_one(&self.pool).await.unwrap_or("N/D".to_string());
        
        let sql_ndd = "SELECT DISTINCT UPPER(RTRIM(LTRIM(SerialNumber))) FROM vw_NDD WHERE data = (SELECT MAX(data) FROM vw_NDD)";
        let ndd_rows: Vec<String> = sqlx::query_scalar(sql_ndd).fetch_all(&self.pool).await?;
        let ndd_set: HashSet<String> = ndd_rows.into_iter().collect();

        let sql_iw = r#"SELECT UPPER(RTRIM(LTRIM([Serial#]))) as serial, LOWER(CAST([Compativel iW] as varchar)) as compativel, LOWER(CAST([Cadastrado no iW] as varchar)) as cadastrado, LOWER(CAST([Possível cadastrar iW] as varchar)) as possivel, CAST([status] as varchar) as status FROM vw_IW_Main WHERE data = (SELECT MAX(data) FROM vw_IW_Main)"#;
        let iw_rows: Vec<crate::models::IwRawData> = sqlx::query_as(sql_iw).fetch_all(&self.pool).await?;

        let mut iw_serials_map: HashMap<String, crate::models::IwRawData> = HashMap::new();
        for row in iw_rows { iw_serials_map.insert(row.serial.clone(), row); }

        let mif = iw_serials_map.len() as i64;
        let mut compatible = 0; let mut not_compatible = 0; let mut registered = 0; let mut not_registered = 0;
        let mut possible = 0; let mut not_possible = 0; let mut possible_canon = 0; let mut possible_inter = 0; let mut iw_only = 0;

        let is_sim = |opt: &Option<String>| -> bool { if let Some(s) = opt { let v = s.trim().to_lowercase(); v == "sim" || v == "s" || v == "1" || v == "yes" } else { false } };

        for (serial, row) in &iw_serials_map {
            let is_in_ndd = ndd_set.contains(serial);
            let comp_iw = is_sim(&row.compativel); let cad_iw = is_sim(&row.cadastrado); let poss_iw = is_sim(&row.possivel);

            if comp_iw || is_in_ndd { compatible += 1; } else { not_compatible += 1; }
            if cad_iw || is_in_ndd { registered += 1; if cad_iw && !is_in_ndd { iw_only += 1; } } 
            else { not_registered += 1; if poss_iw { possible += 1; let st = row.status.as_deref().unwrap_or("").to_lowercase(); if st.contains("canon") { possible_canon += 1; } if st.contains("inter") { possible_inter += 1; } } else { not_possible += 1; } }
        }

        let mut ndd_in_mif = 0;
        for s in &ndd_set { if iw_serials_map.contains_key(s) { ndd_in_mif += 1; } }

        Ok(crate::models::MonitoringData { mif, compatible, not_compatible, registered, not_registered, ndd: ndd_in_mif, iw: iw_only, possible, not_possible, possible_canon, possible_inter, last_date: max_date_str })
    }
}