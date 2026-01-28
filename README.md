# 📊 Monitoramento RPA (NDD-SQL)

**Monitoramento RPA** é uma aplicação desktop de alta performance desenvolvida com **Tauri (Rust)** e **React**, projetada para oferecer uma visão gerencial consolidada de parques de impressão. O sistema conecta-se diretamente a um banco de dados SQL Server para monitorar produção (P&B/Cor), conectividade de dispositivos e realizar projeções inteligentes de faturamento.

## 🚀 Funcionalidades Principais

### 📈 Dashboard de Produção
* **Visualização Dual:** Gráficos de barras empilhadas separando impressões P&B e Coloridas.
* **Modo Comparativo (YoY):** Recurso "Ano a Ano" para comparar o desempenho do mês atual com o mesmo período do ano anterior.
* **Projeção Inteligente:** Algoritmo híbrido (`calculate_smart_projection`) que estima o fechamento do mês baseado na média linear diária ou no histórico consolidado, dependendo do dia do mês.

### 📡 Monitoramento de Comunicação
* **Status de Conectividade:** Monitora dispositivos "ON" (com leitura recente) vs "OFF" (sem leitura há +7 dias).
* **Filtros de Fonte:** Segregação de dados entre fontes **NDD** e **iW** (Canon imageWARE).

### 🏢 Gestão Inteligente de Empresas
* **Normalização de Nomes:** Algoritmo de limpeza (`clean_name_for_display`) que remove sufixos jurídicos (LTDA, S.A., EIRELI) para agrupar filiais automaticamente.
* **Busca Fuzzy:** Datalist com filtragem dinâmica para localizar clientes rapidamente.
* **Fingerprinting:** Agrupamento de dados baseado em assinatura única de texto para evitar duplicidades no relatório.

### ⚡ Performance e Arquitetura
* **Backend em Rust:** Consultas SQL assíncronas de alta velocidade usando `sqlx`.
* **Cache em Memória:** Sistema de `Mutex` no estado da aplicação (`AppState`) para evitar requisições repetitivas ao banco de dados.
* **Splash Screen Nativa:** Tela de carregamento com feedback em tempo real das etapas de inicialização (Conexão, Download, Cálculos).

## 🧰 Tecnologias Utilizadas

### Frontend
* **React + TypeScript:** Interface reativa e tipada.
* **Recharts:** Biblioteca de gráficos customizada para renderização de labels e tooltips complexos.
* **CSS Modules (Dark Mode):** Estilização nativa com paleta de cores escura (`#263238`) e acentos neon (`#00E5FF`).

### Backend (Desktop)
* **Tauri v1:** Framework para aplicações desktop leves e seguras.
* **Rust:** Linguagem do core para gerenciamento de memória e threads.
* **SQLx (v0.6.3):** ORM/Query Builder assíncrono para MSSQL.
* **Tokio:** Runtime assíncrono para operações de I/O não bloqueantes.

## 📦 Estrutura do Projeto

```text
ndd-sql/
├── src/
│   ├── App.tsx            # Lógica de UI, filtros e gráficos (Recharts)
│   ├── App.css            # Estilização global e temas (Dark Theme)
│   ├── main.tsx           # Ponto de entrada do React
│   └── assets/            # Ícones e recursos estáticos
├── src-tauri/
│   ├── src/
│   │   ├── main.rs        # Core da aplicação: Comandos Tauri e State Management
│   │   ├── db.rs          # Camada de Dados: Conexão MSSQL e Queries SQLx
│   │   ├── models.rs      # Structs Rust (ProductionRecord, DashboardData)
│   │   └── lib.rs         # Biblioteca auxiliar Tauri
│   ├── Cargo.toml         # Dependências Rust (sqlx, tokio, serde)
│   └── tauri.conf.json    # Configurações da janela e permissões
└── package.json           # Dependências Frontend
🧪 Como Instalar e Rodar
Pré-requisitos
Node.js (v16+)

Rust (Latest Stable)

Visual Studio C++ Build Tools (para compilação no Windows)

1. Clonar o repositório
Bash
git clone [https://github.com/seu-usuario/ndd-sql.git](https://github.com/seu-usuario/ndd-sql.git)
cd ndd-sql
2. Instalar dependências do Frontend
Bash
npm install
# ou
yarn install
3. Configuração do Banco de Dados
O sistema aguarda uma conexão SQL Server. Verifique o arquivo src-tauri/src/main.rs para ajustar a string de conexão se necessário (atualmente configurada para ambiente de intranet):

Rust
// src-tauri/src/main.rs
let conn_str = "mssql://usuario:senha@ip-servidor/Db_RPA...";
4. Executar em modo de desenvolvimento
Este comando iniciará o Vite (frontend) e compilará o binário Rust simultaneamente.

Bash
npm run tauri dev
🧩 Modelo de Dados (Structs Principais)
O backend Rust mapeia os dados do SQL Server para as seguintes estruturas (models.rs):

ProductionRecord: Armazena volumes de P&B, Cor e contagem de dispositivos por Mês/Ano.

CommunicationRecord: Armazena contagem de dispositivos conectados vs desconectados baseada em regras de "dias sem leitura".

DashboardData: Payload completo enviado ao frontend, contendo vetores de produção, comunicação e datas de última atualização.

💡 Destaques da Lógica de Negócio
Projeção Híbrida (main.rs)
O sistema decide automaticamente como projetar o fechamento do mês:

Início do Mês (< dia 5): Usa média histórica dos meses anteriores para evitar distorções.

Decorrer do Mês: Usa projeção linear baseada na produção diária atual, mas pondera com o histórico se a produção atual estiver anormalmente baixa (ex: feriados).

Queries Otimizadas (db.rs)
Utiliza UNION ALL para combinar tabelas vw_NDD e vw_IW_Main em uma única viagem ao banco, e implementa acquire_timeout reduzido (5s) para falhar rapidamente caso a VPN/Rede não esteja disponível.

🔒 Licença
Este software é de uso interno restrito para monitoramento de ativos.