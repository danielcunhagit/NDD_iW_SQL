📊 Monitoramento RPA (NDD-iW SQL) - v3.0.0
O Monitoramento RPA é uma aplicação desktop de altíssima performance desenvolvida com Tauri (Rust) e React. Projetada para oferecer uma visão gerencial consolidada de parques de impressão, a plataforma unifica dados de telemetria do NDD Print e Canon iW Remote, monitorando produção (P&B/Cor), conectividade de dispositivos e realizando projeções financeiras.

Nesta versão 3.0.0, o sistema adota uma arquitetura Offline-First, utilizando um banco de dados SQLite local aliado a um motor de sincronização em segundo plano (Smart Sync), garantindo inicialização instantânea e resiliência contra quedas de rede/VPN.

🌟 Novidades da Versão 3.0 (A Grande Atualização)
Cérebro Híbrido Autocurável (SQLite Local): O sistema agora salva uma réplica otimizada dos dados em um banco local (rpa_cache.db). A inicialização é instantânea (0 carregamentos de tela), e o sistema funciona perfeitamente em Modo Offline.

Smart Sync (Background Worker): Um robô em Rust roda de forma invisível validando se há novos dados na nuvem (SQL Server). O download ocorre no rodapé, sem congelar a interface (UI), mesclando os dados novos com o cache local graciosamente.

Motor de Notificações Customizadas: Substituição dos balões nativos do Windows por uma "Janela Fantasma" rica em UI. As notificações possuem gráficos, barras de tempo, e suporte a Deep Linking (clicar no alerta redireciona a interface principal para a aba correspondente).

Rotina Matinal (Cron Job): Avaliação automática disparada todos os dias às 09:00, gerando resumos de produção, alertas de risco de meta e o ranking do Top 5 Empresas.

Previsões Semanais (Evolução Acumulada): Novo painel de relatórios interativos com gráficos de linhas (Recharts), comparando o fechamento diário do mês atual com o mês anterior.

Termômetro Visual de Saúde: O rodapé da aplicação analisa a defasagem dos dados e altera suas cores organicamente (Verde, Amarelo, Vermelho) com base no frescor das informações (D-1).

Single Instance & Autostart: O aplicativo inicia automaticamente escondido na bandeja do sistema (System Tray) ao ligar o Windows. Tentar abrir o app novamente apenas "acorda" a janela existente via Socket TCP.

🚀 Funcionalidades Principais
📈 Dashboards de Produção e Análise
Visualização Dual: Gráficos de barras empilhadas separando impressões P&B e Coloridas.

Modo Comparativo (YoY): Recurso "Ano a Ano" para comparar o desempenho do mês atual com o mesmo período do ano anterior.

Projeção Inteligente: Algoritmo que estima o fechamento do mês baseado na média linear diária, bloqueando distorções em feriados ou inícios de mês.

📡 Monitoramento de Comunicação (MIF)
Status de Conectividade: Monitora dispositivos online vs offline, calculando a porcentagem de saúde do parque.

Árvore de Monitoramento: Diagrama detalhado segregando o parque total (MIF) entre equipamentos compatíveis, não compatíveis e oportunidades de instalação (Canon/Inter).

Filtros de Fonte: Segregação ágil de dados entre fontes NDD e iW.

🏢 Gestão Inteligente de Empresas
Normalização de Nomes: Algoritmo de limpeza (clean_name_for_display) que remove sufixos jurídicos (LTDA, S.A., EIRELI) para agrupar filiais automaticamente.

Busca Fuzzy & Fingerprinting: Datalist com filtragem dinâmica baseada em assinaturas únicas de texto para evitar duplicidades no relatório.

⚡ Performance e Arquitetura
Backend em Rust (Tauri v1): Consultas SQL assíncronas e processamento pesado delegados ao core do sistema operacional.

Gestão de Estado Distribuída: Uso intensivo de tokio::sync::Mutex para gerenciar a conexão MSSQL, SQLite e o Cache em RAM simultaneamente.

Paginação e Lazy Loading: Tabelas de detalhamento de equipamentos com paginação nativa no React para lidar com milhares de linhas sem gargalos de renderização.

🧰 Tecnologias Utilizadas
Frontend (Interface)

React 19 + TypeScript: Interface reativa, modular e fortemente tipada.

Vite: Build tool ultrarrápido.

Recharts: Renderização de gráficos customizados, tooltips complexos e eixos dinâmicos.

CSS Modules (Dark Mode): Estilização com paleta escura (#263238) e acentos neon orgânicos.

Backend (Desktop Core)

Tauri v1: Framework para aplicações desktop leves e seguras.

Rust: Gerenciamento de memória, threads e concorrência segura.

SQLx (v0.6.3): ORM/Query Builder assíncrono para acesso ao MSSQL (Nuvem) e SQLite (Local).

Tokio: Runtime assíncrono para operações de I/O não bloqueantes e workers de background.

Tauri Plugin Autostart: Integração nativa com o registro do SO para inicialização com o Windows.

📦 Estrutura do Projeto
Plaintext
ndd-sql/
├── src/
│   ├── App.tsx            # Cérebro da UI, Roteamento, Gráficos (Recharts) e Lógica Híbrida
│   ├── App.css            # Estilização global, animações e paleta de cores
│   ├── main.tsx           # Ponto de entrada (Gerencia Split de Renderização da Janela de Notificação)
│   └── assets/            # Ícones e recursos estáticos
├── src-tauri/
│   ├── src/
│   │   ├── main.rs        # Core: Comandos Tauri, Cron Jobs, System Tray e State Management
│   │   ├── db.rs          # Camada Nuvem: Conexão MSSQL e Queries SQLx
│   │   ├── local_db.rs    # Camada Local: Motor SQLite, Cache WAL e Worker de Sincronização
│   │   ├── models.rs      # Structs Rust (ProductionRecord, DashboardData, etc)
│   │   └── lib.rs         # Biblioteca auxiliar
│   ├── Cargo.toml         # Dependências Rust
│   └── tauri.conf.json    # Configurações de janelas (Main e Notification), permissões e build
└── package.json           # Dependências NPM/Yarn
🧪 Como Instalar e Rodar
Pré-requisitos
Node.js (v16+)

Rust (Latest Stable)

Visual Studio C++ Build Tools (para compilação no Windows com pacote "Desktop development with C++")

1. Clonar o repositório
Bash
git clone https://github.com/seu-usuario/ndd-sql.git
cd ndd-sql
2. Instalar dependências do Frontend
Bash
npm install
3. Configuração do Banco de Dados
O sistema exige uma conexão com o SQL Server na intranet para buscar atualizações. Verifique o arquivo src-tauri/src/main.rs e db.rs para ajustar a string de conexão:

Rust
let conn_str = "mssql://usuario:senha@ip-servidor/Db_RPA?encrypt=true&trustServerCertificate=true";
4. Executar em Modo de Desenvolvimento
Inicia o servidor Vite e compila o binário Rust (na primeira vez, o Cargo fará o download dos pacotes).

Bash
npm run tauri dev
5. Build de Produção
Gera o instalador .exe e os binários otimizados.

Bash
npm run tauri build
🔒 Licença
Este software possui integração com ferramentas proprietárias e é de uso interno restrito para monitoramento de ativos da empresa.