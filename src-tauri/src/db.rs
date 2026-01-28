use sqlx::{mssql::MssqlPoolOptions, Pool, Mssql, Row};
use crate::models::{ProductionRecord, CommunicationRecord};
use std::error::Error;

pub struct Database {
    pool: Pool<Mssql>,
}

impl Database {
    pub async fn new(conn_str: &str) -> Result<Self, Box<dyn Error>> {
        let pool = MssqlPoolOptions::new()
            .max_connections(5)
            // Timeout reduzido para 5s para avisar rápido sobre a VPN
            .acquire_timeout(std::time::Duration::from_secs(5)) 
            .connect(conn_str)
            .await?;
        Ok(Self { pool })
    }

    // --- CORREÇÃO DE PERFORMANCE: OTIMIZAÇÃO MÁXIMA ---
    pub async fn get_raw_companies_with_data(&self, source_filter: &str) -> Result<Vec<(String, String)>, sqlx::Error> {
        let mut companies = Vec::new();

        // Query NDD
        if source_filter == "Consolidado" || source_filter == "NDD" {
            let sql_ndd = r#"
                SELECT DISTINCT EnterpriseName as nm 
                FROM vw_NDD 
                WHERE EnterpriseName IS NOT NULL 
                  AND LTRIM(RTRIM(EnterpriseName)) <> ''
                  AND (pb_total > 0 OR cor_total > 0)
            "#;
            let rows = sqlx::query(sql_ndd).fetch_all(&self.pool).await?;
            for row in rows {
                let name: String = row.try_get(0).unwrap_or_else(|_| "".to_string());
                if !name.is_empty() {
                    companies.push((name, "NDD".to_string()));
                }
            }
        }

        // Query iW
        if source_filter == "Consolidado" || source_filter == "iW" {
            let sql_iw = r#"
                SELECT DISTINCT [Ship To Name] as nm
                FROM vw_IW_Main 
                WHERE [Ship To Name] IS NOT NULL 
                  AND LTRIM(RTRIM([Ship To Name])) <> ''
                  AND (pb_total > 0 OR cor_total > 0)
            "#;
            let rows = sqlx::query(sql_iw).fetch_all(&self.pool).await?;
            for row in rows {
                let name: String = row.try_get(0).unwrap_or_else(|_| "".to_string());
                if !name.is_empty() {
                    companies.push((name, "IW".to_string()));
                }
            }
        }
        
        Ok(companies)
    }

    fn build_in_clause(names: &Vec<String>) -> String {
        if names.is_empty() {
            return "('__NO_MATCH__')".to_string(); 
        }
        let escaped_names: Vec<String> = names.iter()
            .map(|n| format!("'{}'", n.replace("'", "''"))) 
            .collect();
        format!("({})", escaped_names.join(","))
    }

    pub async fn get_production(&self, start_date: &str, target_companies: Option<Vec<String>>) -> Result<Vec<ProductionRecord>, sqlx::Error> {
        let (filter_ndd, filter_iw) = match &target_companies {
            Some(list) if !list.is_empty() => {
                let clause = Self::build_in_clause(list);
                (format!("AND EnterpriseName IN {}", clause), format!("AND [Ship To Name] IN {}", clause))
            },
            _ => (String::new(), String::new())
        };

        let sql = format!(r#"
            SELECT 'NDD' as source, YEAR(data) as ano, MONTH(data) as mes,
                   CAST(SUM(COALESCE(pb_total, 0)) AS BIGINT) as pb, 
                   CAST(SUM(COALESCE(cor_total, 0)) AS BIGINT) as cor,
                   CAST(COUNT(DISTINCT CASE WHEN (COALESCE(pb_total,0)>0 OR COALESCE(cor_total,0)>0) THEN SerialNumber END) AS INT) as devices
            FROM vw_NDD 
            WHERE data >= '{}' {} 
            GROUP BY YEAR(data), MONTH(data)
            UNION ALL
            SELECT 'IW' as source, YEAR(data) as ano, MONTH(data) as mes,
                   CAST(SUM(COALESCE(pb_total, 0)) AS BIGINT) as pb, 
                   CAST(SUM(COALESCE(cor_total, 0)) AS BIGINT) as cor,
                   CAST(COUNT(DISTINCT CASE WHEN (COALESCE(pb_total,0)>0 OR COALESCE(cor_total,0)>0) THEN [Serial#] END) AS INT) as devices
            FROM vw_IW_Main 
            WHERE data >= '{}' {}
            GROUP BY YEAR(data), MONTH(data)
        "#, start_date, filter_ndd, start_date, filter_iw);

        sqlx::query_as::<_, ProductionRecord>(&sql).fetch_all(&self.pool).await
    }

    pub async fn get_communication(&self, start_date: &str, target_companies: Option<Vec<String>>) -> Result<Vec<CommunicationRecord>, sqlx::Error> {
        let (filter_ndd, filter_iw) = match &target_companies {
            Some(list) if !list.is_empty() => {
                let clause = Self::build_in_clause(list);
                (format!("AND EnterpriseName IN {}", clause), format!("AND [Ship To Name] IN {}", clause))
            },
            _ => (String::new(), String::new())
        };

        let sql = format!(r#"
            SELECT 'NDD' as source, YEAR(data) as ano, MONTH(data) as mes,
                CAST(COUNT(DISTINCT CASE WHEN [Days without meters] <= 6 THEN SerialNumber END) AS INT) as connected,
                CAST(COUNT(DISTINCT CASE WHEN [Days without meters] >= 7 THEN SerialNumber END) AS INT) as disconnected
            FROM vw_NDD 
            WHERE data >= '{}' {}
            AND data IN (SELECT MAX(data) FROM vw_NDD WHERE data >= '{}' {} GROUP BY YEAR(data), MONTH(data))
            GROUP BY YEAR(data), MONTH(data)
            UNION ALL
            SELECT 'IW' as source, YEAR(data) as ano, MONTH(data) as mes,
                CAST(COUNT(DISTINCT CASE WHEN [Comunicação iW] = 'sim' THEN [Serial#] END) AS INT) as connected,
                CAST(COUNT(DISTINCT CASE WHEN [Comunicação iW] = 'não' THEN [Serial#] END) AS INT) as disconnected
            FROM vw_IW_Main 
            WHERE data >= '{}' {} AND [Cadastrado no iW] = 'sim' 
            AND data IN (SELECT MAX(data) FROM vw_IW_Main WHERE data >= '{}' {} GROUP BY YEAR(data), MONTH(data))
            GROUP BY YEAR(data), MONTH(data)
        "#, 
        start_date, filter_ndd, start_date, filter_ndd,
        start_date, filter_iw, start_date, filter_iw);
        
        sqlx::query_as::<_, CommunicationRecord>(&sql).fetch_all(&self.pool).await
    }

    // --- FORMATO DE DATA DD/MM/AAAA ---
    pub async fn get_last_date(&self, table: &str) -> String {
        let sql = format!("SELECT CONVERT(varchar, MAX(data), 103) as dt FROM {}", table);
        match sqlx::query(&sql).fetch_one(&self.pool).await {
            Ok(row) => row.try_get::<String, _>(0).unwrap_or_else(|_| "N/D".to_string()),
            Err(_) => "N/D".to_string(),
        }
    }
}