use sqlx::sqlite::{SqlitePool, SqlitePoolOptions, SqliteConnectOptions};
use sqlx::mssql::MssqlPool;
use sqlx::Row;
use std::str::FromStr;
use std::error::Error;
use tauri::{AppHandle, Manager};
use chrono::{Datelike, Local};
use tokio::time::{sleep, Duration};

pub struct LocalDatabase {
    pub pool: SqlitePool,
}

impl LocalDatabase {
    // 1. INICIALIZA O BANCO DE DADOS LOCAL E CRIA AS TABELAS
    pub async fn init(app_handle: &AppHandle) -> Result<Self, Box<dyn Error + Send + Sync>> {
        let app_dir = app_handle.path_resolver().app_data_dir().ok_or("Erro ao localizar AppData")?;
        std::fs::create_dir_all(&app_dir)?; 

        let db_path = app_dir.join("rpa_cache.db");

        // Usando .filename() resolvemos o erro de leitura de caminhos no Windows (C:\...)
        let options = SqliteConnectOptions::new()
            .filename(&db_path)
            .create_if_missing(true)
            .busy_timeout(std::time::Duration::from_secs(15));
            
        let pool = SqlitePoolOptions::new().connect_with(options).await?;

        // MÁGICA 2: Liga o WAL (Write-Ahead Logging). Permite ler os gráficos INSTANTANEAMENTE 
        // mesmo enquanto o robô está gravando milhares de dados pesados no fundo!
        sqlx::query("PRAGMA journal_mode = WAL;").execute(&pool).await?;
        sqlx::query("PRAGMA synchronous = NORMAL;").execute(&pool).await?;
        sqlx::query("PRAGMA temp_store = MEMORY;").execute(&pool).await?;

        // 1º CRIAMOS AS TABELAS
        sqlx::query("CREATE TABLE IF NOT EXISTS local_cache (key TEXT PRIMARY KEY, value TEXT);").execute(&pool).await?;

        sqlx::query(
            "CREATE TABLE IF NOT EXISTS sync_status (year INTEGER, month INTEGER, synced_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (year, month));"
        ).execute(&pool).await?;

        sqlx::query(
            "CREATE TABLE IF NOT EXISTS local_production (source TEXT, ano INTEGER, mes INTEGER, dia INTEGER, serial TEXT, empresa TEXT, pb INTEGER, cor INTEGER, is_online INTEGER);"
        ).execute(&pool).await?;

        // 2º CRIAMOS OS ÍNDICES (Agora a tabela já existe!)
        sqlx::query("CREATE INDEX IF NOT EXISTS idx_prod_ano_mes ON local_production (ano, mes);").execute(&pool).await?;
        sqlx::query("CREATE INDEX IF NOT EXISTS idx_prod_empresa ON local_production (empresa);").execute(&pool).await?;
        sqlx::query("CREATE INDEX IF NOT EXISTS idx_prod_ano_empresa ON local_production (ano, empresa);").execute(&pool).await?;
        sqlx::query("CREATE INDEX IF NOT EXISTS idx_prod_dates ON local_production (source, ano, mes, dia);").execute(&pool).await?;
        sqlx::query("CREATE INDEX IF NOT EXISTS idx_prod_comm ON local_production (empresa, ano, mes);").execute(&pool).await?;

        // ---> ADICIONE ESTAS TRÊS LINHAS (A VACINA DO RUST) <---
        // Converte qualquer string vazia que causaria o travamento para textos seguros
        let _ = sqlx::query("UPDATE local_production SET empresa = 'N/D' WHERE empresa = '' OR empresa IS NULL;").execute(&pool).await;
        let _ = sqlx::query("UPDATE local_production SET serial = 'UNKNOWN' WHERE serial = '' OR serial IS NULL;").execute(&pool).await;
        let _ = sqlx::query("UPDATE local_cache SET value = '{}' WHERE value = '' OR value IS NULL;").execute(&pool).await;

        Ok(Self { pool })
    }

    // 2. O MOTOR QUE RODA EM SEGUNDO PLANO BAIXANDO DE 2 EM 2 MESES
    pub fn start_sync_worker(app: AppHandle, sqlite: SqlitePool, mssql: MssqlPool) {
        tokio::spawn(async move {
            // REMOVIDO: A pausa de 5 segundos. O robô agora ataca a base de dados instantaneamente!
            let _ = app.emit_all("sync-status", "Robô iniciado! Verificando histórico pendente...");
            
            let current_year = Local::now().year();
            let current_month = Local::now().month() as i32;

            let mut months_to_sync = Vec::new();
            for y in (2020..=current_year).rev() {
                let m_start = if y == current_year { current_month } else { 12 };
                for m in (1..=m_start).rev() {
                    months_to_sync.push((y, m));
                }
            }

            for chunk in months_to_sync.chunks(2) {
                let mut needs_sync = false;
                let mut msg_months = Vec::new();

                for &(y, m) in chunk {
                    let is_synced: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM sync_status WHERE year = ? AND month = ?")
                        .bind(y).bind(m).fetch_one(&sqlite).await.unwrap_or((0,));
                    
                    if is_synced.0 == 0 || (y == current_year && m == current_month) {
                        needs_sync = true;
                        msg_months.push(format!("{:02}/{}", m, y));
                    }
                }

                if needs_sync {
                    let _ = app.emit_all("sync-status", format!("Baixando dados da Nuvem: {}...", msg_months.join(" e ")));
                    
                    for &(y, m) in chunk {
                        let _ = sqlx::query("DELETE FROM sync_status WHERE year = ? AND month = ?")
                            .bind(y).bind(m).execute(&sqlite).await;

                        // VACINA SQL: Se for vazio (''), vira NULL, e o ISNULL transforma em 'UNKNOWN'/'N/D'
                        let q_ndd = format!("SELECT DAY(data) as dia, ISNULL(NULLIF(SerialNumber, ''), 'UNKNOWN') as serial, ISNULL(NULLIF(EnterpriseName, ''), 'N/D') as empresa, CAST(ISNULL(pb_total, 0) as bigint) as pb, CAST(ISNULL(cor_total, 0) as bigint) as cor, CASE WHEN [Days without meters] <= 7 THEN 1 ELSE 0 END as is_online FROM vw_NDD WHERE YEAR(data) = {} AND MONTH(data) = {}", y, m);
                        let q_iw = format!("SELECT DAY(w.data) as dia, ISNULL(NULLIF(w.[Serial#], ''), 'UNKNOWN') as serial, ISNULL(NULLIF(w.[Ship To Name], ''), 'N/D') as empresa, CAST(ISNULL(w.pb_total, 0) as bigint) as pb, CAST(ISNULL(w.cor_total, 0) as bigint) as cor, CASE WHEN w.[Lapsed Days] <= 7 THEN 1 ELSE 0 END as is_online FROM vw_IW_Main w WHERE YEAR(w.data) = {} AND MONTH(w.data) = {} AND w.[Cadastrado no iW] = 'sim' AND NOT EXISTS (SELECT 1 FROM vw_NDD n WHERE n.SerialNumber = w.[Serial#] AND YEAR(n.data) = YEAR(w.data) AND MONTH(n.data) = MONTH(w.data))", y, m);

                        let (ndd_res, iw_res) = tokio::join!(
                            sqlx::query(&q_ndd).fetch_all(&mssql),
                            sqlx::query(&q_iw).fetch_all(&mssql)
                        );

                        // ---> MÁGICA DA RESILIÊNCIA AQUI:
                        // Só processa, grava e marca como concluído se o SQL Server devolver "Ok"
                        // Se der falha de rede/timeout, ele cai no 'else' e pula o mês, 
                        // deixando o status vazio para tentar de novo no futuro!
                        // ---> MÁGICA DA RESILIÊNCIA AQUI:
                        // ---> MÁGICA DA RESILIÊNCIA AQUI:
                        if let (Ok(ndd_rows), Ok(iw_rows)) = (ndd_res, iw_res) {
                            let mut tx = sqlite.begin().await.unwrap();

                            // ---> CORREÇÃO CRÍTICA: Apaga os dados do mês antes de inserir, evitando duplicação!
                            let _ = sqlx::query("DELETE FROM local_production WHERE ano = ? AND mes = ?")
                                .bind(y).bind(m).execute(&mut *tx).await;

                            // 1. GRAVA A PRODUÇÃO NDD
                            for r in ndd_rows {
                                let dia = r.try_get::<i32, _>("dia").unwrap_or(1);
                                
                                // TRAVA DE SEGURANÇA: Filtra espaços em branco pós-conversão
                                let mut serial = r.try_get::<Option<String>, _>("serial").unwrap_or(None).unwrap_or_else(|| "UNKNOWN".to_string());
                                if serial.trim().is_empty() { serial = "UNKNOWN".to_string(); }
                                
                                let mut empresa = r.try_get::<Option<String>, _>("empresa").unwrap_or(None).unwrap_or_else(|| "N/D".to_string());
                                if empresa.trim().is_empty() { empresa = "N/D".to_string(); }
                                let pb = r.try_get::<i64, _>("pb").unwrap_or(0);
                                let cor = r.try_get::<i64, _>("cor").unwrap_or(0);
                                let is_online = r.try_get::<i32, _>("is_online").unwrap_or(0);

                                let _ = sqlx::query("INSERT INTO local_production (source, ano, mes, dia, serial, empresa, pb, cor, is_online) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
                                    .bind("NDD").bind(y).bind(m).bind(dia).bind(&serial).bind(&empresa).bind(pb).bind(cor).bind(is_online)
                                    .execute(&mut *tx).await;
                            }

                            // 2. GRAVA A PRODUÇÃO IW
                            for r in iw_rows {
                                let dia = r.try_get::<i32, _>("dia").unwrap_or(1);
                                let serial = r.try_get::<Option<String>, _>("serial").unwrap_or(None).unwrap_or_else(|| "UNKNOWN".to_string());
                                let empresa = r.try_get::<Option<String>, _>("empresa").unwrap_or(None).unwrap_or_else(|| "N/D".to_string());
                                let pb = r.try_get::<i64, _>("pb").unwrap_or(0);
                                let cor = r.try_get::<i64, _>("cor").unwrap_or(0);
                                let is_online = r.try_get::<i32, _>("is_online").unwrap_or(0);

                                let _ = sqlx::query("INSERT INTO local_production (source, ano, mes, dia, serial, empresa, pb, cor, is_online) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
                                    .bind("IW").bind(y).bind(m).bind(dia).bind(&serial).bind(&empresa).bind(pb).bind(cor).bind(is_online)
                                    .execute(&mut *tx).await;
                            }

                            // 3. COMITA NO BANCO E SALVA O STATUS
                            tx.commit().await.unwrap();
                            let _ = sqlx::query("INSERT OR REPLACE INTO sync_status (year, month) VALUES (?, ?)")
                                .bind(y).bind(m).execute(&sqlite).await;
                                
                            let _ = app.emit_all("sync-chunk-done", ());
                        } else {
                            // ---> AGORA ELE AVISA A TELA QUE DEU ERRO DE REDE E VAI TENTAR O PRÓXIMO <---
                            let _ = app.emit_all("sync-status", format!("Falha de conexão ao baixar {}/{}. Tentando próximo...", m, y));
                            println!("Aviso: Falha ou Timeout ao baixar a Nuvem para {}/{}. Tentará novamente depois.", m, y);
                            sleep(Duration::from_secs(3)).await; // Dá um respiro para a rede
                        }
                    }
                }
            }
            
            let _ = app.emit_all("sync-status", "Banco de dados local 100% sincronizado!");
            sleep(Duration::from_secs(4)).await;
            let _ = app.emit_all("sync-status", ""); 
        });
    }

    // --- 3. FUNÇÕES DE LEITURA ULTRARRÁPIDA (O HÍBRIDO) ---

    // Verifica se um determinado ano já foi 100% baixado pelo robô
    pub async fn is_year_fully_synced(pool: &SqlitePool, year: i32) -> bool {
        let current_year = Local::now().year();
        let expected_months = if year == current_year { Local::now().month() as i64 } else { 12 };
        
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM sync_status WHERE year = ?")
            .bind(year).fetch_one(pool).await.unwrap_or((0,));
            
        count.0 >= expected_months
    }

    // Verifica se um mês ESPECÍFICO já foi baixado (Para gráficos diários/semanais)
    pub async fn is_month_synced(pool: &SqlitePool, year: i32, month: i32) -> bool {
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM sync_status WHERE year = ? AND month = ?")
            .bind(year).bind(month).fetch_one(pool).await.unwrap_or((0,));
        count.0 > 0
    }

    // ---> NOVA FUNÇÃO: Retorna uma lista com todos os anos que já foram 100% baixados <---
    pub async fn get_synced_years(pool: &SqlitePool) -> Vec<i32> {
        let current_year = Local::now().year();
        let mut synced = Vec::new();
        for y in 2020..=current_year {
            let expected = if y == current_year { Local::now().month() as i64 } else { 12 };
            let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM sync_status WHERE year = ?")
                .bind(y).fetch_one(pool).await.unwrap_or((0,));
            if count.0 >= expected {
                synced.push(y);
            }
        }
        synced
    }

    // Busca a última atualização sem tocar na nuvem
    pub async fn get_local_last_date(pool: &SqlitePool, source: &str) -> String {
        let query = format!("SELECT ano, mes, dia FROM local_production WHERE source = '{}' ORDER BY ano DESC, mes DESC, dia DESC LIMIT 1", source);
        if let Ok(row) = sqlx::query_as::<_, (i32, i32, i32)>(&query).fetch_one(pool).await {
            return format!("{:04}-{:02}-{:02}", row.0, row.1, row.2);
        }
        "N/D".to_string()
    }

    // Busca a lista de empresas ativas em um ano (Livre de empresas com produção zerada)
    // Busca a lista de empresas ativas em um ano (Livre de empresas com produção zerada)
    pub async fn get_local_active_companies_in_year(pool: &SqlitePool, year: i32) -> Result<Vec<(String, i64)>, Box<dyn Error + Send + Sync>> {
        // COALESCE evita o Crash de string vazia!
        let query = format!("SELECT COALESCE(NULLIF(empresa, ''), 'N/D') as empresa, CAST(SUM(pb + cor) AS BIGINT) as cnt FROM local_production WHERE ano = {} GROUP BY empresa HAVING SUM(pb + cor) > 0", year);
        let rows: Vec<(String, i64)> = sqlx::query_as(&query).fetch_all(pool).await?;
        Ok(rows)
    }

    pub async fn get_local_production(pool: &SqlitePool, year: i32, company_filter: Option<Vec<String>>) -> Result<Vec<crate::models::ProductionRecord>, Box<dyn Error + Send + Sync>> {
        // Tudo convertido para BIGINT e strings blindadas
        let mut query = format!("SELECT COALESCE(NULLIF(source, ''), 'UNKNOWN') as source, ano, mes, CAST(SUM(pb) AS BIGINT) as pb, CAST(SUM(cor) AS BIGINT) as cor, CAST(COUNT(DISTINCT CASE WHEN (pb + cor) > 0 THEN serial END) AS BIGINT) as devices FROM local_production WHERE ano >= {}", year);
        if let Some(companies) = company_filter {
            if !companies.is_empty() {
                let list_str = companies.iter().map(|c| format!("'{}'", c.replace("'", "''"))).collect::<Vec<_>>().join(",");
                query.push_str(&format!(" AND empresa IN ({})", list_str));
            }
        }
        query.push_str(" GROUP BY source, ano, mes ORDER BY ano DESC, mes DESC");
        let records = sqlx::query_as::<_, crate::models::ProductionRecord>(&query).fetch_all(pool).await?;
        Ok(records)
    }

    pub async fn get_local_communication(pool: &SqlitePool, year: i32, company_filter: Option<Vec<String>>) -> Result<Vec<crate::models::CommunicationRecord>, Box<dyn Error + Send + Sync>> {
        let mut query = format!("WITH Ranked AS (SELECT COALESCE(NULLIF(source, ''), 'UNKNOWN') as source, ano, mes, is_online, ROW_NUMBER() OVER(PARTITION BY source, ano, mes, serial ORDER BY dia DESC) as rn FROM local_production WHERE ano >= {} ", year);
        if let Some(companies) = company_filter {
            if !companies.is_empty() {
                let list_str = companies.iter().map(|c| format!("'{}'", c.replace("'", "''"))).collect::<Vec<_>>().join(",");
                query.push_str(&format!(" AND empresa IN ({})", list_str));
            }
        }
        query.push_str(") SELECT source, ano, mes, CAST(SUM(CASE WHEN is_online = 1 THEN 1 ELSE 0 END) AS BIGINT) as connected, CAST(SUM(CASE WHEN is_online = 0 THEN 1 ELSE 0 END) AS BIGINT) as disconnected FROM Ranked WHERE rn = 1 GROUP BY source, ano, mes ORDER BY ano DESC, mes DESC");
        let records = sqlx::query_as::<_, crate::models::CommunicationRecord>(&query).fetch_all(pool).await?;
        Ok(records)
    }

    pub async fn get_local_daily_production(pool: &SqlitePool, year: i32, month: i32, source: String, company_filter: Option<Vec<String>>) -> Result<Vec<crate::DailyProd>, Box<dyn Error + Send + Sync>> {
        let mut query = format!("SELECT dia, CAST(SUM(pb + cor) AS BIGINT) as total FROM local_production WHERE ano = {} AND mes = {}", year, month);
        if source != "Consolidado" { query.push_str(&format!(" AND source = '{}'", source.to_uppercase())); }
        if let Some(companies) = company_filter {
            if !companies.is_empty() {
                let list_str = companies.iter().map(|c| format!("'{}'", c.replace("'", "''"))).collect::<Vec<_>>().join(",");
                query.push_str(&format!(" AND empresa IN ({})", list_str));
            }
        }
        query.push_str(" GROUP BY dia ORDER BY dia");
        let records = sqlx::query_as::<_, crate::DailyProd>(&query).fetch_all(pool).await?;
        Ok(records)
    }

// --- FUNÇÕES DO PAINEL LATERAL (SIDE PANEL) 100% LOCAIS ---

    pub async fn get_local_month_company_summary(pool: &SqlitePool, year: i32, month: i32) -> Result<Vec<crate::models::CompanySummary>, Box<dyn Error + Send + Sync>> {
        let query = format!(r#"
            WITH Ranked AS (
                SELECT COALESCE(NULLIF(source, ''), 'UNKNOWN') as source, COALESCE(NULLIF(empresa, ''), 'N/D') as empresa, is_online, ROW_NUMBER() OVER(PARTITION BY source, serial ORDER BY dia DESC) as rn
                FROM local_production WHERE ano = {} AND mes = {}
            ),
            Prod AS (
                SELECT COALESCE(NULLIF(source, ''), 'UNKNOWN') as source, COALESCE(NULLIF(empresa, ''), 'N/D') as empresa, CAST(SUM(pb + cor) AS BIGINT) as producao
                FROM local_production WHERE ano = {} AND mes = {} GROUP BY source, empresa
            )
            SELECT r.source, r.empresa, 
                CAST(SUM(CASE WHEN r.is_online = 1 THEN 1 ELSE 0 END) AS BIGINT) as online,
                CAST(SUM(CASE WHEN r.is_online = 0 THEN 1 ELSE 0 END) AS BIGINT) as offline,
                IFNULL(p.producao, 0) as producao
            FROM Ranked r
            LEFT JOIN Prod p ON r.source = p.source AND r.empresa = p.empresa
            WHERE r.rn = 1
            GROUP BY r.source, r.empresa
            ORDER BY offline DESC, producao DESC
        "#, year, month, year, month);
        
        let records = sqlx::query_as::<_, crate::models::CompanySummary>(&query).fetch_all(pool).await?;
        Ok(records)
    }

    pub async fn get_local_month_details(pool: &SqlitePool, year: i32, month: i32, company_filter: Option<Vec<String>>) -> Result<Vec<crate::models::DeviceDetail>, Box<dyn Error + Send + Sync>> {
        let mut query = format!(r#"
            SELECT COALESCE(NULLIF(source, ''), 'UNKNOWN') as source, COALESCE(NULLIF(serial, ''), 'UNKNOWN') as serial, COALESCE(NULLIF(empresa, ''), 'N/D') as empresa, 
                   CAST(SUM(pb) AS BIGINT) as pb, 
                   CAST(SUM(cor) AS BIGINT) as cor, 
                   CAST(SUM(pb + cor) AS BIGINT) as total
            FROM local_production 
            WHERE ano = {} AND mes = {}
        "#, year, month);
        
        if let Some(companies) = company_filter {
            if !companies.is_empty() {
                let list_str = companies.iter().map(|c| format!("'{}'", c.replace("'", "''"))).collect::<Vec<_>>().join(",");
                query.push_str(&format!(" AND empresa IN ({})", list_str));
            }
        }
        query.push_str(" GROUP BY source, serial, empresa ORDER BY total DESC");
        
        let records = sqlx::query_as::<_, crate::models::DeviceDetail>(&query).fetch_all(pool).await?;
        Ok(records)
    }

// --- FUNÇÕES DE CACHE INSTANTÂNEO (Usado para o Monitoramento MIF) ---
    pub async fn get_cache(pool: &SqlitePool, key: &str) -> Option<String> {
        let row: Result<(String,), _> = sqlx::query_as("SELECT COALESCE(NULLIF(value, ''), '{}') FROM local_cache WHERE key = ?").bind(key).fetch_one(pool).await;
        row.map(|r| r.0).ok()
    }

    pub async fn set_cache(pool: &SqlitePool, key: &str, value: &str) {
        let _ = sqlx::query("INSERT OR REPLACE INTO local_cache (key, value) VALUES (?, ?)").bind(key).bind(value).execute(pool).await;
    }

    // --- FUNÇÃO FALTANTE: GARANTE QUE O ANO ATUAL SEJA BAIXADO NO 1º ACESSO ---
    pub async fn sync_current_year(app: &AppHandle, sqlite: &SqlitePool, mssql: &MssqlPool) -> Result<(), Box<dyn Error + Send + Sync>> {
        let current_year = Local::now().year();
        let current_month = Local::now().month() as i32;

        let mut months_to_sync = Vec::new();
        for m in (1..=current_month).rev() {
            let is_synced: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM sync_status WHERE year = ? AND month = ?")
                .bind(current_year).bind(m).fetch_one(sqlite).await.unwrap_or((0,));
            
            if is_synced.0 == 0 || m == current_month {
                months_to_sync.push((current_year, m));
            }
        }

        if months_to_sync.is_empty() { return Ok(()); }

        for chunk in months_to_sync.chunks(2) {
            let msg_months: Vec<String> = chunk.iter().map(|&(_, m)| format!("{:02}/{}", m, current_year)).collect();
            let _ = app.emit_all("splash-status", format!("Baixando ano corrente: {}...", msg_months.join(" e ")));

            for &(y, m) in chunk {
                let _ = sqlx::query("DELETE FROM sync_status WHERE year = ? AND month = ?").bind(y).bind(m).execute(sqlite).await;

                // VACINA SQL: Aplicada também no sincronizador de ano atual!
                let q_ndd = format!("SELECT DAY(data) as dia, ISNULL(NULLIF(SerialNumber, ''), 'UNKNOWN') as serial, ISNULL(NULLIF(EnterpriseName, ''), 'N/D') as empresa, CAST(ISNULL(pb_total, 0) as bigint) as pb, CAST(ISNULL(cor_total, 0) as bigint) as cor, CASE WHEN [Days without meters] <= 7 THEN 1 ELSE 0 END as is_online FROM vw_NDD WHERE YEAR(data) = {} AND MONTH(data) = {}", y, m);
                let q_iw = format!("SELECT DAY(w.data) as dia, ISNULL(NULLIF(w.[Serial#], ''), 'UNKNOWN') as serial, ISNULL(NULLIF(w.[Ship To Name], ''), 'N/D') as empresa, CAST(ISNULL(w.pb_total, 0) as bigint) as pb, CAST(ISNULL(w.cor_total, 0) as bigint) as cor, CASE WHEN w.[Lapsed Days] <= 7 THEN 1 ELSE 0 END as is_online FROM vw_IW_Main w WHERE YEAR(w.data) = {} AND MONTH(w.data) = {} AND w.[Cadastrado no iW] = 'sim' AND NOT EXISTS (SELECT 1 FROM vw_NDD n WHERE n.SerialNumber = w.[Serial#] AND YEAR(n.data) = YEAR(w.data) AND MONTH(n.data) = MONTH(w.data))", y, m);

                let (ndd_res, iw_res) = tokio::join!(sqlx::query(&q_ndd).fetch_all(mssql), sqlx::query(&q_iw).fetch_all(mssql));

                if let (Ok(ndd_rows), Ok(iw_rows)) = (ndd_res, iw_res) {
                    let mut tx = sqlite.begin().await?;
                    let _ = sqlx::query("DELETE FROM local_production WHERE ano = ? AND mes = ?").bind(y).bind(m).execute(&mut *tx).await;

                    for r in ndd_rows {
                        let dia = r.try_get::<i32, _>("dia").unwrap_or(1);
                        let serial = r.try_get::<Option<String>, _>("serial").unwrap_or(None).unwrap_or_else(|| "UNKNOWN".to_string());
                        let empresa = r.try_get::<Option<String>, _>("empresa").unwrap_or(None).unwrap_or_else(|| "N/D".to_string());
                        let pb = r.try_get::<i64, _>("pb").unwrap_or(0);
                        let cor = r.try_get::<i64, _>("cor").unwrap_or(0);
                        let is_online = r.try_get::<i32, _>("is_online").unwrap_or(0);

                        let _ = sqlx::query("INSERT INTO local_production (source, ano, mes, dia, serial, empresa, pb, cor, is_online) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
                            .bind("NDD").bind(y).bind(m).bind(dia).bind(&serial).bind(&empresa).bind(pb).bind(cor).bind(is_online)
                            .execute(&mut *tx).await;
                    }

                    for r in iw_rows {
                        let dia = r.try_get::<i32, _>("dia").unwrap_or(1);
                        let serial = r.try_get::<Option<String>, _>("serial").unwrap_or(None).unwrap_or_else(|| "UNKNOWN".to_string());
                        let empresa = r.try_get::<Option<String>, _>("empresa").unwrap_or(None).unwrap_or_else(|| "N/D".to_string());
                        let pb = r.try_get::<i64, _>("pb").unwrap_or(0);
                        let cor = r.try_get::<i64, _>("cor").unwrap_or(0);
                        let is_online = r.try_get::<i32, _>("is_online").unwrap_or(0);

                        let _ = sqlx::query("INSERT INTO local_production (source, ano, mes, dia, serial, empresa, pb, cor, is_online) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
                            .bind("IW").bind(y).bind(m).bind(dia).bind(&serial).bind(&empresa).bind(pb).bind(cor).bind(is_online)
                            .execute(&mut *tx).await;
                    }

                    tx.commit().await?;
                    let _ = sqlx::query("INSERT OR REPLACE INTO sync_status (year, month) VALUES (?, ?)").bind(y).bind(m).execute(sqlite).await;
                }
            }
        }
        Ok(())
    }

}