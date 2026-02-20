import { useState, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, ReferenceLine } from "recharts";
import "./App.css";
import { open } from '@tauri-apps/api/shell';

// --- TYPES (Mantidos) ---
interface DashboardData {
  production: { source: string; ano: number; mes: number; pb: number; cor: number; devices: number }[];
  communication: { source: string; ano: number; mes: number; connected: number; disconnected: number }[];
  last_update_ndd: string;
  last_update_iw: string;
  projection: { ndd_pb: number; ndd_cor: number; iw_pb: number; iw_cor: number };
  total_equipments: number;
  total_companies: number;
}

interface MonitoringData {
    mif: number; compatible: number; not_compatible: number; registered: number; not_registered: number;
    ndd: number; iw: number; possible: number; not_possible: number;
    possible_canon: number; possible_inter: number; last_date: string;
}

interface ToastMsg {
    message: string;
    type: 'info' | 'success';
    visible: boolean;
}

// interface DeviceDetail {
//     source: string;
//     serial: string;
//     empresa: string | null;
//     pb: number;
//     cor: number;
//     total: number;
// }

// interface CompanySummary {
//     source: string;
//     empresa: string;
//     online: number;
//     offline: number;
//     producao: number;
// }

type SortKey = 'source' | 'serial' | 'empresa' | 'pb' | 'cor' | 'total' | 'online' | 'offline' | 'producao';
interface SortConfig {
    key: SortKey;
    direction: 'asc' | 'desc';
}

type ViewType = 'production_current' | 'production_compare' | 'communication' | 'monitoring';

const MESES = ["", "Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const fmtMilhar = (val: number) => val > 0 ? val.toLocaleString('pt-BR') : '0';
const formatDate = (dateStr: string | undefined) => { if (!dateStr || dateStr === "N/D") return "N/D"; try { return new Date(dateStr + "T00:00:00").toLocaleDateString('pt-BR'); } catch { return dateStr; } };

// ... (MonitoringView, RenderLabels e Tooltips MANTIDOS IGUAIS para economizar espaço aqui, mas devem estar no arquivo) ...
// CÓPIA DOS COMPONENTES VISUAIS (Mantenha os que você já tem: MonitoringView, RenderPBLabel, DefaultTooltip, etc)
const MonitoringView = ({ data }: { data: MonitoringData | null }) => {
    if (!data) return <div style={{display:'flex', height:'100%', alignItems:'center', justifyContent:'center', color:'#B0BEC5'}}>Carregando diagrama...</div>;

    const ProCard = ({ title, value, total, status = "neutral", hasNext = false }: any) => {
        const pct = total > 0 ? Math.round((value / total) * 100) : 0;
        return (
            <div className={`flow-card status-${status} ${hasNext ? 'has-next' : ''} expand`}>
                <div className="card-header">
                    <span className="card-title">{title}</span>
                    {total > 0 && total !== value && <span className="card-pct">{pct}%</span>}
                </div>
                <div className="card-body">
                    <span className="card-value">{fmtMilhar(value)}</span>
                    <span className="card-label">eqp</span>
                </div>
            </div>
        );
    };

    return (
        <div className="monitoring-container">
            {/* Nível 1: Total */}
            <div className="col-level" style={{flex: 0.8}}>
                <ProCard title="Parque Total (MIF)" value={data.mif} status="main" hasNext={true} />
            </div>

            {/* Nível 2: Compatibilidade */}
            <div className="col-level">
                <div className="card-group grouped">
                    <ProCard title="Compatíveis" value={data.compatible} total={data.mif} status="good" hasNext={true} />
                </div>
                <div className="card-group grouped">
                    <ProCard title="Incompatíveis" value={data.not_compatible} total={data.mif} status="bad" />
                </div>
            </div>

            {/* Nível 3: Monitoramento */}
            <div className="col-level">
                <div className="card-group grouped" style={{flexGrow: 1.5}}>
                    <ProCard title="Monitorados" value={data.registered} total={data.compatible} status="good" hasNext={true} />
                </div>
                <div className="card-group grouped" style={{flexGrow: 1}}>
                    <ProCard title="Sem Monitoramento" value={data.not_registered} total={data.compatible} status="warn" hasNext={true} />
                </div>
                <div className="card-group" style={{flexGrow: 0.5, visibility: 'hidden'}}></div>
            </div>

            {/* Nível 4: Detalhes Finais */}
            <div className="col-level">
                {/* Detalhes de Monitorados */}
                <div className="card-group grouped" style={{flexGrow: 1.5}}>
                    <ProCard title="NDD Print" value={data.ndd} total={data.registered} status="neutral" />
                    <ProCard title="iW Remote" value={data.iw} total={data.registered} status="neutral" />
                </div>

                {/* Detalhes de Sem Monitoramento (Oportunidades) */}
                <div className="card-group grouped" style={{flexGrow: 1}}>
                    <div style={{display:'flex', flexDirection:'column', gap: 5, padding:'8px', background:'rgba(0,0,0,0.2)', borderRadius:4, border:'1px solid #546E7A', marginBottom: 5}}>
                        <div style={{fontSize:9, color:'#B0BEC5', fontWeight:'bold', marginBottom:2, textAlign:'center'}}>OPORTUNIDADES (POSSÍVEL)</div>
                        <div style={{display:'flex', gap:5}}>
                            <div style={{flex:1}}><ProCard title="Canon" value={data.possible_canon} status="good" /></div>
                            <div style={{flex:1}}><ProCard title="Inter" value={data.possible_inter} status="warn" /></div>
                        </div>
                    </div>
                    <ProCard title="Não Possível" value={data.not_possible} total={data.not_registered} status="bad" />
                </div>
                <div className="card-group" style={{flexGrow: 0.5, visibility: 'hidden'}}></div>
            </div>

            <div style={{position:'absolute', bottom: 10, right: 20, fontSize: 10, color: '#546E7A'}}>
                Ref: {formatDate(data.last_date)}
            </div>
        </div>
    );
};

const RenderCompCurrLabel = (props: any) => { 
    const { x, y, width, height, value, payload } = props;
    if (!value) return null; 
    
    // Adicionado o `?.` para não dar erro na animação inicial do gráfico
    const hasGap = payload?.total_gap > 0; 
    const placeInside = hasGap && height > 15;
    const textY = placeInside ? y + 12 : y - 5; 
    const textFill = placeInside ? "#000" : "#fff"; 
    return <text x={x + width / 2} y={textY} fill={textFill} textAnchor="middle" fontSize={10} fontWeight="bold">{fmtMilhar(value)}</text>; 
};

const RenderCompProjLabel = (props: any) => { 
    const { x, y, width, payload } = props;
    
    // Trava de segurança total aqui também
    if (!payload || !payload.total_gap || payload.total_gap <= 0) return null; 
    
    return <text x={x + width / 2} y={y - 8} fill="#FFD740" textAnchor="middle" fontSize={11} fontWeight="bold" fontStyle="italic">{fmtMilhar(payload.total_proj)}</text>; 
};

const RenderPBLabel = ({ x, y, width, height, value, payload }: any) => { if (!payload || !value) return null; const showTotalHere = (payload.cor || 0) === 0; const totalReal = payload.total_prod; return ( <g style={{ pointerEvents: 'none' }}> {height > 12 && <text x={x + width / 2} y={y + height / 2} fill="white" textAnchor="middle" dominantBaseline="middle" fontSize={10} fontWeight="bold">{fmtMilhar(value)}</text>} {showTotalHere && <text x={x + width / 2} y={y - 8} fill="white" textAnchor="middle" fontSize={11} fontWeight="bold">{totalReal?.toLocaleString('pt-BR')}</text>} </g> ); };
const RenderCorLabel = ({ x, y, width, height, value, payload }: any) => { if (!payload || !value) return null; const totalReal = payload.total_prod; return ( <g style={{ pointerEvents: 'none' }}> {height > 12 && <text x={x + width / 2} y={y + height / 2} fill="black" textAnchor="middle" dominantBaseline="middle" fontSize={10} fontWeight="bold">{fmtMilhar(value)}</text>} <text x={x + width / 2} y={y - 8} fill="white" textAnchor="middle" fontSize={11} fontWeight="bold">{totalReal?.toLocaleString('pt-BR')}</text> </g> ); };
const RenderProjectionLabel = ({ x, y, width, value }: any) => { if (!value) return null; return <text x={x + width / 2} y={y - 8} fill="#FFD740" textAnchor="middle" fontSize={11} fontWeight="bold" fontStyle="italic">{value.toLocaleString('pt-BR')}</text>; };
const RenderCommLabel = ({ x, y, width, height, payload, type }: any) => { 
    if (!payload || !payload.total_devs) return null; 
    const qtd = payload[type]; 
    if (!qtd || qtd === 0) return null; 
    
    // Percentual arredondado
    const pct = Math.round((qtd / payload.total_devs) * 100); 
    const centerY = y + height / 2; 
    
    // Limite reduzido para 10px (antes era 14px) para mostrar em mais barras
    if (height < 10) return null; 

    return ( 
        <g style={{ pointerEvents: 'none' }}> 
            <text x={x + width / 2} y={centerY} fill="white" textAnchor="middle" dominantBaseline="middle" fontSize={11} fontWeight="bold" style={{ textShadow: '0 0 2px #000' }}> 
                {/* Mostra % se couber */}
                <tspan x={x + width / 2} dy={height > 20 ? "-0.5em" : "0"}>{pct}%</tspan> 
                {/* Mostra valor absoluto apenas se a barra for alta o suficiente (>20px) */}
                {height > 20 && <tspan x={x + width / 2} dy="1.2em">({fmtMilhar(qtd)})</tspan>} 
            </text> 
        </g> 
    ); 
};
const RenderCompLabel = ({ x, y, width, value, fill }: any) => { if (!value) return null; return <text x={x + width / 2} y={y - 5} fill={fill} textAnchor="middle" fontSize={10} fontWeight="bold">{fmtMilhar(value)}</text>; };
const DefaultTooltip = ({ active, payload, label, view, sourceFilter, selectedYear }: any) => { 
    if (active && payload && payload.length) { 
        const d = payload[0].payload; 
        if (view.startsWith('production') && (d.pb + d.cor) === 0) return null; 
        if (view === 'communication' && d.total_devs === 0) return null; 
        
        const activeDevices = d.devices || 0; 
        const average = activeDevices > 0 ? Math.round(d.total_prod / activeDevices) : 0; 
        let tags = null; 
        
        if (d.has_ndd && d.has_iw) { 
            tags = <><span className="source-tag src-ndd">NDD</span><span className="source-tag src-iw">iW</span></>; 
        } else if (d.has_ndd) { 
            tags = <span className="source-tag src-ndd">NDD</span>; 
        } else if (d.has_iw) { 
            tags = <span className="source-tag src-iw">iW</span>; 
        } 
        
        // --- LÓGICA DO MÊS PARCIAL ---
        const currentMonthIdx = new Date().getMonth() + 1; 
        const currentYear = new Date().getFullYear();
        const labelMonthIdx = MESES.indexOf(label);
        const isCurrentMonth = (labelMonthIdx === currentMonthIdx && selectedYear === currentYear);
        // -----------------------------

        return ( 
            <div style={{ background: '#263238', border: '1px solid #546E7A', padding: '12px', borderRadius: '6px', minWidth: 160, zIndex: 100 }}> 
                <p style={{ fontWeight: 'bold', color: 'white', marginBottom: 8, fontSize: 13, textAlign: 'center' }}>{label}</p> 
                
                {view.startsWith('production') ? ( 
                    <> 
                        <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', color: '#B0BEC5', fontSize: 11, marginBottom: 4, fontWeight: 'bold', borderBottom: '1px solid #37474F'}}> 
                            <span>PRODUÇÃO</span> <div>{tags}</div> 
                        </div> 
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{color:'#546E7A'}}>P&B:</span><span style={{color:'#fff', fontWeight:'bold'}}>{d.pb.toLocaleString()}</span></div> 
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{color:'#00E5FF'}}>Cor:</span><span style={{color:'#fff', fontWeight:'bold'}}>{d.cor.toLocaleString()}</span></div> 
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2, marginBottom: 4 }}> 
                            <span style={{color:'#fff'}}>Total:</span><span style={{color:'#fff', fontWeight:'bold'}}>{(d.pb+d.cor).toLocaleString()}</span> 
                        </div> 
                        <div style={{ borderTop:'1px solid #546E7A', margin: '4px 0' }}></div> 
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{color:'#B0BEC5'}}>Impressoras produzindo:</span><span style={{color:'#fff', fontWeight:'bold'}}>{activeDevices.toLocaleString()}</span></div> 
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{color:'#B0BEC5'}}>Média / imp.:</span><span style={{color:'#FFD740', fontWeight:'bold'}}>{average.toLocaleString()}</span></div> 
                        {d.total_proj > (d.pb+d.cor) && <p style={{color: '#FFD740', textAlign:'right', marginTop:4, fontSize:11}}>Est: {d.total_proj.toLocaleString()}</p>} 
                    </> 
                ) : ( 
                    <> 
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{color:'#26A69A'}}>ON:</span><span style={{color:'#fff'}}>{d.connected.toLocaleString()} ({d.pct_conn}%)</span></div> 
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{color:'#EF5350'}}>OFF:</span><span style={{color:'#fff'}}>{d.disconnected.toLocaleString()} ({d.pct_disc}%)</span></div> 
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, borderTop:'1px solid #37474F', paddingTop: 6 }}><span style={{color:'#B0BEC5'}}>Total:</span><span style={{color:'#fff', fontWeight:'bold'}}>{d.total_devs.toLocaleString()}</span></div> 
                        
                        {/* --- INDICADOR PARCIAL NA CAIXINHA --- */}
                        <div style={{ marginTop: 8, textAlign: 'center', background: d.pct_conn >= 90 ? 'rgba(38, 166, 154, 0.1)' : 'rgba(239, 83, 80, 0.1)', padding: '4px', borderRadius: '4px' }}>
                            {d.pct_conn >= 90 ? (
                                <span style={{ color: '#00E5FF', fontWeight: 'bold', fontSize: 11 }}>
                                    {isCurrentMonth ? "★ NA META (PARCIAL)" : "★ META ATINGIDA"}
                                </span>
                            ) : (
                                <span style={{ color: '#FFD740', fontWeight: 'bold', fontSize: 11 }}>
                                    {isCurrentMonth ? "⚠ ABAIXO DA META (PARCIAL)" : "⚠ ABAIXO DA META"}
                                </span>
                            )}
                        </div>
                    </> 
                )} 
            </div> 
        ); 
    } 
    return null; 
};

const ComparisonTooltip = ({ active, payload, label, selectedYear, lastUpdateDate }: any) => { if (active && payload && payload.length >= 2) { const prevData = payload.find((p: any) => p.dataKey === "prev_total"); const currData = payload.find((p: any) => p.dataKey === "curr_total"); if (!prevData || !currData) return null; const d = payload[0].payload; const prevVal = prevData.value; const currVal = currData.value; let dbDay = 0; let dbMonth = 0; let dbYear = 0; if (lastUpdateDate && lastUpdateDate !== "N/D") { const parts = lastUpdateDate.split('-'); if(parts.length === 3) { dbYear = parseInt(parts[0]); dbMonth = parseInt(parts[1]); dbDay = parseInt(parts[2]); } } const monthIndex = MESES.indexOf(label); const isCurrentMonthInDb = (selectedYear === dbYear) && (monthIndex === dbMonth); const isFutureMonth = (selectedYear === dbYear) && (monthIndex > dbMonth); let currentLabelText = `${currData.name}`; if (isCurrentMonthInDb && dbDay > 0) { currentLabelText = `Prod. até ${dbDay.toString().padStart(2, '0')}/${dbMonth.toString().padStart(2, '0')}`; } let diffDisplay = <></>; let estimateRow = <></>; if (prevVal > 0) { if (currVal === 0 && isFutureMonth) { diffDisplay = <span style={{color: '#90A4AE', fontStyle: 'italic', fontSize: 11}}>Aguardando dados...</span>; } else { let valToCompare = currVal; let isEstComparison = false; if (isCurrentMonthInDb && d.total_proj > currVal) { valToCompare = d.total_proj; isEstComparison = true; estimateRow = ( <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 11 }}> <span style={{color: '#FFD740', fontStyle: 'italic'}}>Produção estimada:</span> <span style={{color: '#fff', fontWeight: 'bold'}}>{fmtMilhar(d.total_proj)}</span> </div> ); } const diffPct = ((valToCompare - prevVal) / prevVal) * 100; let colorDiff = "#B0BEC5"; let diffText = "Estável"; if (diffPct > 0) { diffText = "Aumento"; colorDiff = "#00E676"; } else if (diffPct < 0) { diffText = "Diminuição"; colorDiff = "#EF5350"; } let diffSuffix = isEstComparison ? " (Est.)" : ""; diffDisplay = <span style={{color: colorDiff}}>{diffText}{diffSuffix} {Math.abs(diffPct).toFixed(2)}%</span>; } } else if (currVal > 0) { diffDisplay = <span style={{color: "#00E676"}}>Novo (100.00%)</span>; } return ( <div style={{ background: '#263238', border: '1px solid #546E7A', padding: '12px', borderRadius: '6px', minWidth: 180, zIndex: 100 }}> <p style={{ fontWeight: 'bold', color: 'white', marginBottom: 8, fontSize: 13, textAlign: 'center', borderBottom: '1px solid #455A64', paddingBottom: 4 }}>{label}</p> <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 12 }}> <span style={{color: '#90A4AE'}}>{prevData.name}:</span> <span style={{color: '#fff', fontWeight: 'bold'}}>{fmtMilhar(prevVal)}</span> </div> <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 12 }}> <span style={{color: '#00E5FF'}}>{currentLabelText}:</span> <span style={{color: '#fff', fontWeight: 'bold'}}>{fmtMilhar(currVal)}</span> </div> {estimateRow} <div style={{ borderTop: '1px solid #455A64', paddingTop: 6, textAlign: 'center', fontSize: 13, fontWeight: 'bold' }}>{diffDisplay}</div> </div> ); } return null; };

function App() {
const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [splashStatus, setSplashStatus] = useState("Iniciando...");
  const [splashProgress, setSplashProgress] = useState(10);
  const [splashError, setSplashError] = useState<string | null>(null);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState(""); 
  const [statusText, setStatusText] = useState("");
  const [data, setData] = useState<DashboardData | null>(null);
  const [consolidatedData, setConsolidatedData] = useState<DashboardData | null>(null);
  const [companyCache, setCompanyCache] = useState<Record<string, DashboardData>>({}); 
  const [monitoringData, setMonitoringData] = useState<MonitoringData | null>(null);
  const [showGoalLine, setShowGoalLine] = useState(false);
  const [bgLoading, setBgLoading] = useState(false);
  const [areCompaniesReady, setAreCompaniesReady] = useState(false);
  const [toast, setToast] = useState<ToastMsg>({ message: '', type: 'info', visible: false });
  const [companyList, setCompanyList] = useState<string[]>([]);
  const [currentView, setCurrentView] = useState<ViewType>('production_current');  
        useEffect(() => {
            if (currentView === 'communication') {
                setShowGoalLine(false);
                const timer = setTimeout(() => setShowGoalLine(true), 900); 
                return () => clearTimeout(timer);
            }
        }, [currentView]);
  const [year, setYear] = useState(new Date().getFullYear());
  const [source, setSource] = useState("Consolidado");
  const [tempCompany, setTempCompany] = useState(""); 
  const [selectedCompany, setSelectedCompany] = useState("");

  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [panelLoading, setPanelLoading] = useState(false);
  const [panelMonthIndex, setPanelMonthIndex] = useState(0);
  const [panelData, setPanelData] = useState<any[]>([]); 
  const [panelType, setPanelType] = useState<'detail' | 'summary'>('detail');
  const [activeTab, setActiveTab] = useState<'producing' | 'stopped'>('producing');
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 15;
  const [sortConfig, setSortConfig] = useState<SortConfig>({ key: 'total', direction: 'desc' });
  const [panelCache, setPanelCache] = useState<Record<string, any[]>>({});
  const fetchedKeys = useRef<Set<string>>(new Set());

  // --- PRÉ-CARREGAMENTO EM BACKGROUND ---
  useEffect(() => {
      if (!data || !data.production) return;

      // Descobre todos os meses que têm produção no ano atual, ordenando do mais recente para o mais antigo
      const monthsToFetch = [...new Set(
          data.production
              .filter(p => p.ano === year && (p.pb + p.cor) > 0)
              .map(p => p.mes)
      )].sort((a, b) => b - a);

      if (monthsToFetch.length === 0) return;

      let isCancelled = false;

      const prefetchAll = async () => {
          const isGeneralView = !selectedCompany;
          const command = isGeneralView ? "fetch_month_summary_cmd" : "fetch_month_details_cmd";

          for (const month of monthsToFetch) {
              if (isCancelled) break; // Se o usuário mudar de tela/filtro, cancela a fila atual

              const cacheKey = `${year}-${selectedCompany || 'GERAL'}-${month}`;
              
              // Se já baixou ou está baixando, pula para o próximo mês
              if (fetchedKeys.current.has(cacheKey) || panelCache[cacheKey]) continue;

              fetchedKeys.current.add(cacheKey); // Marca que já fomos buscar

              try {
                  const args: any = { year, month };
                  if (!isGeneralView) args.company = selectedCompany;

                  const res = await invoke<any[]>(command, args);
                  if (isCancelled) break;

                  // Salva os dados silenciosamente no cache do painel
                  setPanelCache(prev => ({ ...prev, [cacheKey]: res }));

                  // Dá um respiro de 300ms entre cada requisição para não travar o banco de dados nem a interface
                  await new Promise(r => setTimeout(r, 300));
              } catch (err) {
                  console.error(`Erro ao pré-carregar mês ${month}:`, err);
                  fetchedKeys.current.delete(cacheKey); // Tira da lista para tentar depois
              }
          }
      };

      prefetchAll();

      return () => { isCancelled = true; };
  }, [data, year, selectedCompany]);

  // --- NOVOS ESTADOS PARA O MODAL DE RECONEXÃO ---
  const [connectionError, setConnectionError] = useState(false);
  const [retryAction, setRetryAction] = useState<(() => void) | null>(null);

  const didInit = useRef(false);

  const showToast = (message: string, type: 'info' | 'success') => { setToast({ message, type, visible: true }); setTimeout(() => setToast(prev => ({ ...prev, visible: false })), 4000); };
    const availableYears = useMemo(() => { 
        if (!data) return [new Date().getFullYear()]; 
        const years = new Set<number>(); 
        
        // Adiciona apenas anos válidos (>= 2020)
        data.production.forEach(d => { if (d.ano >= 2020) years.add(d.ano); }); 
        data.communication.forEach(d => { if (d.ano >= 2020) years.add(d.ano); }); 
        
        // Se a lista estiver vazia (ex: banco novo), garante pelo menos o ano atual
        if (years.size === 0) years.add(new Date().getFullYear());

        return Array.from(years).sort((a, b) => b - a); 
    }, [data]);

  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    let unlisten: any; let unlistenMonitor: any; let unlistenLoading: any; let unlistenCompanies: any;
    const startSystem = async () => {
        try {
            unlisten = await listen("splash-status", (event: any) => { setSplashStatus(event.payload as string); setSplashProgress(prev => Math.min(prev + 10, 95)); });
            unlistenMonitor = await listen("monitoring-status", (event: any) => { setStatusText(event.payload as string); });
            unlistenLoading = await listen("loading-status", (event: any) => { setStatusText(event.payload as string); });
            unlistenCompanies = await listen("companies-ready", () => {
                console.log(">>> Evento companies-ready recebido!"); // Debug
                setAreCompaniesReady(true);
                // Busca a lista imediatamente
                invoke<string[]>("fetch_companies", { year: new Date().getFullYear() })
                    .then((list) => {
                        setCompanyList(list);
                        setStatusText("Lista de empresas atualizada.");
                        // Força o fim de qualquer loading residual se necessário
                        setBgLoading(false); 
                    })
                    .catch(err => console.error("Erro ao buscar empresas:", err));
            });

            const initialData = await invoke<DashboardData>("perform_initial_load");
            setSplashProgress(100); setSplashStatus("Carregado."); setData(initialData); setConsolidatedData(initialData); setStatusText("Consolidado.");
            await invoke("finalize_startup"); setTimeout(() => { setIsInitialLoad(false); }, 300);

            const currY = new Date().getFullYear();
            showToast(`Dados de ${currY} prontos.`, 'info');
            setBgLoading(true); setStatusText("Atualizando histórico antigo...");
            
            invoke<DashboardData>("fetch_full_history").then(historyData => {
                setData(prev => { if (!prev) return historyData; return { ...prev, production: [...prev.production, ...historyData.production], communication: [...prev.communication, ...historyData.communication] }; });
                setConsolidatedData(prev => { if (!prev) return historyData; return { ...prev, production: [...prev.production, ...historyData.production], communication: [...prev.communication, ...historyData.communication] }; });
                setStatusText("Histórico completo."); setBgLoading(false);
            }).catch(console.error);
            invoke<MonitoringData>("fetch_monitoring_data").then(setMonitoringData);
        } catch (err) { 
            console.error("ERRO CRÍTICO:", err); 
            // ALTERAÇÃO AQUI: Mensagem fixa em vez de 'String(err)'
            setSplashError("Não conectado. Você precisa estar na VPN para se conectar ao banco de dados."); 
        }
    };
    startSystem();
    return () => { if(unlisten) unlisten(); if(unlistenMonitor) unlistenMonitor(); if(unlistenLoading) unlistenLoading(); if(unlistenCompanies) unlistenCompanies(); };
  }, []);

  useEffect(() => { if(!isInitialLoad && areCompaniesReady) { invoke<string[]>("fetch_companies", { year: year }).then(setCompanyList); } }, [year, areCompaniesReady, isInitialLoad]);

  // --- FUNÇÃO AUXILIAR PARA TRATAR ERROS DE CONEXÃO ---
  const handleApiError = (err: any, retryCallback: () => void) => {
      console.error("API ERROR:", err);
      setLoadingMsg(""); // Limpa mensagem de loading
      setIsLoadingData(false); // Para o spinner global
      setPanelLoading(false); // Para o spinner do painel
      setRetryAction(() => retryCallback); // Guarda a função para tentar de novo
      setConnectionError(true); // Abre o modal
  };

const handleFetchData = async (empresa: string) => {
    // Se limpar o filtro, restaura o consolidado
    if (!empresa) { 
        if (consolidatedData) { 
            setData(consolidatedData); 
            setStatusText("Visão Consolidada restaurada."); 
        } 
        return; 
    }

    // Se já tiver o Dashboard no cache, usa ele
    if (companyCache[empresa]) { 
        setData(companyCache[empresa]); 
        setStatusText(`Filtro: ${empresa} (Cache)`); 
        // A linha do prefetchPanelData que ficava aqui foi removida!
        return; 
    }
    
    setIsLoadingData(true); 
    setLoadingMsg("Preparando filtro..."); 
    setStatusText("Filtrando...");
    
    const unlisten = await listen("splash-status", (event: any) => setLoadingMsg(event.payload as string));
    
    invoke<DashboardData>("fetch_dashboard_data", { company: empresa, year: year })
        .then(res => { 
            setData(res); 
            setCompanyCache(prev => ({ ...prev, [empresa]: res })); 
            setIsLoadingData(false); // Libera a UI primeiro
            
            // A linha do prefetchPanelData que dava erro aqui também foi removida!
        })
        .catch(err => handleApiError(err, () => handleFetchData(empresa)))
        .finally(() => { unlisten(); });
};

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => { const val = e.target.value; setTempCompany(val); const match = companyList.find(c => c.toLowerCase() === val.toLowerCase()); if (match && match !== selectedCompany) { setSelectedCompany(match); handleFetchData(match); } else if (val === "") { setTempCompany(""); setSelectedCompany(""); handleFetchData(""); } };
  const clearCompanyFilter = () => { setTempCompany(""); setSelectedCompany(""); handleFetchData(""); };

const loadPanelData = (monthIndex: number, yearOverride?: number) => {
      setPanelLoading(true);
      setPanelData([]);
      setActiveTab('producing');
      setCurrentPage(1);

      // Usa o ano passado por parâmetro ou o estado atual se não informado
      const targetYear = yearOverride !== undefined ? yearOverride : year;

      const isGeneralView = !selectedCompany; 
      // Cache Key agora usa o targetYear correto
      const cacheKey = `${targetYear}-${selectedCompany || 'GERAL'}-${monthIndex}`;

      if (panelCache[cacheKey]) {
          setPanelData(panelCache[cacheKey]);
          setPanelType(isGeneralView ? 'summary' : 'detail');
          setSortConfig(isGeneralView ? { key: 'offline', direction: 'desc' } : { key: 'total', direction: 'desc' });
          setPanelLoading(false);
          return;
      }

      const command = isGeneralView ? "fetch_month_summary_cmd" : "fetch_month_details_cmd";
      // Usa targetYear na chamada do backend
      const args: any = { year: targetYear, month: monthIndex };
      if (!isGeneralView) args.company = selectedCompany;

      invoke<any[]>(command, args)
          .then(res => {
              setPanelData(res);
              setPanelCache(prev => ({ ...prev, [cacheKey]: res }));
              setPanelType(isGeneralView ? 'summary' : 'detail');
              setSortConfig(isGeneralView ? { key: 'offline', direction: 'desc' } : { key: 'total', direction: 'desc' });
              setPanelLoading(false);
          })
          .catch(err => handleApiError(err, () => loadPanelData(monthIndex, targetYear))); 
  };

  const handleBarClick = (data: any) => {
      if (!data || !currentView.startsWith('production')) return;
      const monthIndex = MESES.indexOf(data.name);
      if (monthIndex < 1) return;

      setPanelMonthIndex(monthIndex);
      setIsPanelOpen(true);
      loadPanelData(monthIndex);
  };

const changePanelMonth = (delta: number) => {
      let newIndex = panelMonthIndex + delta;
      let newYear = year;

      // Lógica de virada de ano
      if (newIndex < 1) {
          newIndex = 12;      // Volta para Dezembro
          newYear = year - 1; // Do ano anterior
      } 
      else if (newIndex > 12) {
          newIndex = 1;       // Avança para Janeiro
          newYear = year + 1; // Do próximo ano
      }

      setPanelMonthIndex(newIndex);
      
      // Se o ano mudou, atualiza o estado global do ano também
      if (newYear !== year) {
          setYear(newYear);
      }

      // Chama o carregamento passando o ano explicitamente
      // (pois o setYear é assíncrono e não teria atualizado ainda)
      loadPanelData(newIndex, newYear);
  };

  const handleSort = (key: SortKey) => {
      setSortConfig(prev => ({ key, direction: prev.key === key && prev.direction === 'desc' ? 'asc' : 'desc' }));
  };

  const displayedData = useMemo(() => {
      if (!panelData) return [];
      let filtered = panelData;

      if (panelType === 'detail') {
          if (activeTab === 'producing') filtered = filtered.filter(d => d.total > 0);
          else filtered = filtered.filter(d => d.total === 0);
      }

      const sorted = [...filtered];
      sorted.sort((a, b) => {
          let aVal = a[sortConfig.key];
          let bVal = b[sortConfig.key];
          if (aVal === null || aVal === undefined) aVal = ""; if (bVal === null || bVal === undefined) bVal = "";
          if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
          if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
          return 0;
      });
      return sorted;
  }, [panelData, sortConfig, activeTab, panelType]);

  const paginatedData = useMemo(() => {
      const start = (currentPage - 1) * itemsPerPage;
      return displayedData.slice(start, start + itemsPerPage);
  }, [displayedData, currentPage]);

  const totalPages = Math.ceil(displayedData.length / itemsPerPage);

  const chartData = useMemo(() => {
    if (!data) return [];
        const grouped = Array.from({ length: 13 }, (_, i) => ({ 
            name: MESES[i], pb: 0, cor: 0, devices: 0, 
            pb_gap: 0, cor_gap: 0, total_gap: 0, connected: 0, disconnected: 0,
            total_devs: 0, total_prod: 0, total_proj: 0, 
            pct_conn: 0, pct_disc: 0, prev_total: 0, curr_total: 0,
            has_ndd: false, has_iw: false 
        }));
    
    const prevYear = year - 1;
    const filterFn = (d: { source: string }) => { if (source === "Consolidado") return true; if (source === "NDD") return d.source === "NDD"; if (source === "iW") return d.source === "IW"; return false; };
    
    if (currentView.startsWith('production')) {
      data.production.filter(filterFn).forEach(d => { 
        if (d.ano === year) { 
            grouped[d.mes].pb += d.pb; 
            grouped[d.mes].cor += d.cor; 
            grouped[d.mes].devices += d.devices; 
            grouped[d.mes].total_prod += (d.pb + d.cor); 
            grouped[d.mes].curr_total += (d.pb + d.cor);
            if (d.source === "NDD" && (d.pb + d.cor) > 0) grouped[d.mes].has_ndd = true;
            if (d.source === "IW" && (d.pb + d.cor) > 0) grouped[d.mes].has_iw = true;
        } 
        if (currentView === 'production_compare' && d.ano === prevYear) grouped[d.mes].prev_total += (d.pb + d.cor); 
      });

      let targetMonth = new Date().getFullYear() === year ? new Date().getMonth() + 1 : -1;
      let targetYear = new Date().getFullYear();
      if (data.last_update_ndd && data.last_update_ndd !== "N/D") { 
          try { const parts = data.last_update_ndd.split('-'); if (parts.length === 3) { targetYear = parseInt(parts[0]); targetMonth = parseInt(parts[1]); } } catch (e) {} 
      }
      
      if (year === targetYear && data.projection) { 
        const cm = targetMonth; 
        let estPB = 0, estCor = 0; 
        if (source === "Consolidado") { estPB = data.projection.ndd_pb + data.projection.iw_pb; estCor = data.projection.ndd_cor + data.projection.iw_cor; } 
        else if (source === "NDD") { estPB = data.projection.ndd_pb; estCor = data.projection.ndd_cor; } 
        else if (source === "iW") { estPB = data.projection.iw_pb; estCor = data.projection.iw_cor; } 
      
        if (cm >= 1 && cm <= 12) { 
            grouped[cm].pb_gap = Math.max(0, estPB - grouped[cm].pb); 
            grouped[cm].cor_gap = Math.max(0, estCor - grouped[cm].cor); 
            grouped[cm].total_gap = grouped[cm].pb_gap + grouped[cm].cor_gap; 
            grouped[cm].total_proj = grouped[cm].total_prod + grouped[cm].pb_gap + grouped[cm].cor_gap; 
        }
      } // <--- ESSA FOI A CHAVE QUE FALTOU E QUEBROU O CÓDIGO!
      
    } else {
      data.communication.filter(filterFn).forEach(d => { if (d.ano === year) { grouped[d.mes].connected += d.connected; grouped[d.mes].disconnected += d.disconnected; } });
      grouped.forEach(g => { g.total_devs = g.connected + g.disconnected; if (g.total_devs > 0) { g.pct_conn = Math.round((g.connected/g.total_devs)*100); g.pct_disc = Math.round((g.disconnected/g.total_devs)*100); } });
    }
    
    return grouped.slice(1);
  }, [data, currentView, year, source]);

  const footerStats = useMemo(() => { if (!data) return { companies: 0, equipments: 0 }; if (selectedCompany) { return { companies: 1, equipments: data.total_equipments }; } if (currentView === 'monitoring' && monitoringData) { return { companies: data.total_companies, equipments: monitoringData.mif }; } const maxEquipments = chartData.reduce((max, curr) => { const devs = currentView.startsWith('production') ? curr.devices : curr.total_devs; return devs > max ? devs : max; }, 0); return { companies: companyList.length, equipments: maxEquipments }; }, [data, monitoringData, currentView, chartData, companyList, selectedCompany]);
  const formatYAxis = (val: number) => currentView === 'communication' ? `${(val * 100).toFixed(0)}%` : `${(val/1000000).toFixed(1)}M`;

  return (
    <>
{isInitialLoad && (
        // ADICIONADO: Classe dinâmica 'is-error' para controlar a animação via CSS
        <div className={`splash-container ${splashError ? 'is-error' : ''}`}>
          <div className="splash-top-bar" />
          
          <div className="splash-icon-box">
            {splashError ? <div className="splash-error-mark">!</div> : <div className="splash-spinner"></div>}
          </div>
          
          <h1 className="splash-title">MONITORAMENTO RPA</h1>
          
          {/* ALTERAÇÃO: O status e a barra de progresso somem quando dá erro, economizando espaço */}
          {!splashError && (
            <>
              <p className="splash-status">{splashStatus}</p>
              <div className="splash-progress-bg">
                <div className={`splash-progress-fill`} style={{ width: `${splashProgress}%` }}></div>
              </div>
            </>
          )}

          {splashError && (
            <div className="splash-error-container">
              <p className="splash-error-title">ERRO</p>
              <p className="splash-error-desc">{splashError}</p>
              <div className="splash-actions">
                <button className="btn-retry" onClick={() => window.location.reload()}>Tentar Novamente</button>
                <button className="btn-exit" onClick={() => invoke("quit_app")}>Fechar</button>
              </div>
            </div>
          )}
          
          <div className="splash-version">v1.0.0</div>
        </div>
      )}
      {isLoadingData && !isInitialLoad && ( <div className="loading-modal-overlay"> <div className="loading-box"> <div className="loading-spinner"></div> <div className="loading-text">{loadingMsg}</div> </div> </div> )}
      {toast.visible && ( <div className={`toast-container ${toast.type}`}> <span className="toast-icon">{toast.type === 'success' ? '✓' : 'ℹ'}</span> <span>{toast.message}</span> </div> )}

      {/* --- MODAL DE ERRO DE CONEXÃO (NOVO) --- */}
      {connectionError && (
        <div className="connection-error-overlay">
            <div className="connection-box">
                <div className="connection-icon">⚠️</div>
                <div className="connection-title">Conexão Perdida</div>
                <p className="connection-desc">
                    Não foi possível obter os dados do servidor. Verifique sua conexão VPN ou internet.
                </p>
                <div className="connection-actions">
                    <button className="btn-reconnect" onClick={() => { setConnectionError(false); if (retryAction) retryAction(); }}>
                        Tentar Novamente
                    </button>
                    <button className="btn-close-app" onClick={() => invoke("quit_app")}>
                        Sair
                    </button>
                </div>
            </div>
        </div>
      )}

      {isPanelOpen && <div className="side-panel-overlay" onClick={() => setIsPanelOpen(false)} />}
      <div className={`side-panel ${isPanelOpen ? 'open' : ''}`}>
          <div className="panel-header">
              <div>
                  <div className="panel-title"> {MESES[panelMonthIndex]}/{year} - Detalhes </div>
                  <div className="panel-subtitle">{selectedCompany || "Visão Geral do Parque"}</div>
              </div>
              <div style={{display:'flex', alignItems:'center'}}>
                  <div className="month-nav">
                      <button className="nav-btn" onClick={() => changePanelMonth(-1)} title="Mês Anterior">{'<'}</button>
                      <button className="nav-btn" onClick={() => changePanelMonth(1)} title="Próximo Mês">{'>'}</button>
                  </div>
                  <button className="close-btn" onClick={() => setIsPanelOpen(false)}>×</button>
              </div>
          </div>
          
          {panelType === 'detail' && (
              <div className="tabs">
                  <button className={`tab-btn ${activeTab === 'producing' ? 'active' : ''}`} onClick={() => { setActiveTab('producing'); setCurrentPage(1); }}>Produzindo</button>
                  <button className={`tab-btn ${activeTab === 'stopped' ? 'active' : ''}`} onClick={() => { setActiveTab('stopped'); setCurrentPage(1); }}>Paradas</button>
              </div>
          )}

          <div className="panel-content">
              {panelLoading ? ( <div style={{display:'flex', justifyContent:'center', padding: 40, color:'#B0BEC5'}}>Carregando...</div> ) : (
                  <table className="detail-table">
                      <thead>
                          <tr>
                              {panelType === 'summary' ? (
                                  <>
                                    <th onClick={() => handleSort('source')}>Origem {sortConfig.key === 'source' && (sortConfig.direction === 'asc' ? '▲' : '▼')}</th>
                                    <th onClick={() => handleSort('empresa')}>Empresa {sortConfig.key === 'empresa' && (sortConfig.direction === 'asc' ? '▲' : '▼')}</th>
                                    <th className="val-col" onClick={() => handleSort('online')}>Online {sortConfig.key === 'online' && (sortConfig.direction === 'asc' ? '▲' : '▼')}</th>
                                    <th className="val-col" onClick={() => handleSort('offline')} style={{color:'#EF5350'}}>Offline {sortConfig.key === 'offline' && (sortConfig.direction === 'asc' ? '▲' : '▼')}</th>
                                    <th className="val-col" onClick={() => handleSort('producao')}>Prod. {sortConfig.key === 'producao' && (sortConfig.direction === 'asc' ? '▲' : '▼')}</th>
                                  </>
                              ) : (
                                  <>
                                    <th onClick={() => handleSort('source')}>Origem {sortConfig.key === 'source' && (sortConfig.direction === 'asc' ? '▲' : '▼')}</th>
                                    <th onClick={() => handleSort('serial')}>Série {sortConfig.key === 'serial' && (sortConfig.direction === 'asc' ? '▲' : '▼')}</th>
                                    <th className="val-col" onClick={() => handleSort('pb')}>P&B {sortConfig.key === 'pb' && (sortConfig.direction === 'asc' ? '▲' : '▼')}</th>
                                    <th className="val-col" onClick={() => handleSort('cor')}>Cor {sortConfig.key === 'cor' && (sortConfig.direction === 'asc' ? '▲' : '▼')}</th>
                                    <th className="val-col" onClick={() => handleSort('total')}>Total {sortConfig.key === 'total' && (sortConfig.direction === 'asc' ? '▲' : '▼')}</th>
                                  </>
                              )}
                          </tr>
                      </thead>
                      <tbody>
                          {paginatedData.length === 0 ? ( <tr><td colSpan={5} style={{textAlign:'center', padding:20}}>Nada encontrado.</td></tr> ) : (
                              paginatedData.map((row, idx) => ( 
                                  <tr key={idx}> 
                                      <td><span className={`source-tag src-${row.source.toLowerCase()}`}>{row.source}</span></td> 
                                      
                                      {panelType === 'summary' ? (
                                          <>
                                            <td style={{fontWeight:'bold', color:'#fff', fontSize:11}}>{row.empresa}</td>
                                            <td className="val-col status-online">{row.online}</td>
                                            <td className="val-col status-offline">{row.offline}</td>
                                            <td className="val-col total-col">{fmtMilhar(row.producao)}</td>
                                          </>
                                      ) : (
                                          <>
                                            <td>{row.serial}</td>
                                            <td className="val-col" style={{color:'#B0BEC5'}}>{fmtMilhar(row.pb)}</td>
                                            <td className="val-col" style={{color:'#00E5FF'}}>{fmtMilhar(row.cor)}</td>
                                            <td className="val-col total-col">{fmtMilhar(row.total)}</td>
                                          </>
                                      )}
                                  </tr> 
                              ))
                          )}
                      </tbody>
                  </table>
              )}
          </div>

          {!panelLoading && displayedData.length > 0 && (
              <div className="pagination">
                  <span>Pág. {currentPage} de {totalPages} • {displayedData.length} registros</span>
                  <div>
                      <button className="page-btn" disabled={currentPage === 1} onClick={() => setCurrentPage(p => p - 1)}>Anterior</button>
                      <button className="page-btn" disabled={currentPage === totalPages} onClick={() => setCurrentPage(p => p + 1)}>Próxima</button>
                  </div>
              </div>
          )}
      </div>

      {!isInitialLoad && (
      <div className={`container ${isLoadingData ? 'blurred' : ''}`}>
        <header>
          {/* ... HEADER MANTIDO IGUAL ... */}
          <div className="left-controls">
            <div className="view-selector">
                <button onClick={() => setCurrentView('production_current')} className={currentView === 'production_current' ? 'active' : ''}>Produção (Atual)</button>
                <button onClick={() => setCurrentView('production_compare')} className={currentView === 'production_compare' ? 'active' : ''}>Ano a Ano</button>
                <button onClick={() => setCurrentView('communication')} className={currentView === 'communication' ? 'active' : ''}>Comunicação</button>
                <button onClick={() => setCurrentView('monitoring')} className={currentView === 'monitoring' ? 'active' : ''}>Monitoramento</button>
            </div>
          </div>
          <h2>{currentView === 'production_compare' ? `Comparativo ${year} vs ${year-1}` : currentView === 'communication' ? 'Status de Comunicação' : currentView === 'monitoring' ? 'Monitoramento de Parque (MIF)' : 'Visão Geral de Produção'}</h2>
          {currentView !== 'monitoring' && (
            <div className="filters">
               <div className="filter-group">
                   <label>Empresa</label>
                   <div className="input-wrapper">
                       <input list="companies" placeholder={areCompaniesReady ? "Todas..." : "Preparando lista..."} value={tempCompany} onChange={handleInputChange} disabled={!areCompaniesReady} style={!areCompaniesReady ? {cursor: 'wait', opacity: 0.7} : {}} />
                       {tempCompany && <button className="clear-btn" onClick={clearCompanyFilter}>✕</button>}
                       <datalist id="companies">{companyList.map((c, i) => <option key={i} value={c} />)}</datalist>
                   </div>
               </div>
               <div className="filter-group"><label>Ano</label><select value={year} onChange={e => setYear(Number(e.target.value))}>{availableYears.map(y => <option key={y} value={y}>{y}</option>)}</select></div>
               <div className="filter-group"><label>Fonte</label><select value={source} onChange={e => setSource(e.target.value)}><option value="Consolidado">Consolidado</option><option value="NDD">NDD</option><option value="iW">iW</option></select></div>
            </div>
          )}
        </header>

        <div className="chart-frame">
            {currentView === 'monitoring' ? ( <MonitoringView data={monitoringData} /> ) : (
                <ResponsiveContainer width="100%" height="100%">
                    {currentView === 'production_compare' ? (
                        <BarChart data={chartData} onClick={handleBarClick} style={{cursor:'pointer'}} barGap={2} margin={{top: 20, right: 30, left: 20, bottom: 5}}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#37474F" vertical={false} />
                            <XAxis dataKey="name" stroke="#B0BEC5" tick={{fontSize: 12}} />
                            <YAxis stroke="#B0BEC5" tickFormatter={formatYAxis} tick={{fontSize: 11}} />
                            <Tooltip content={<ComparisonTooltip selectedYear={year} lastUpdateDate={data?.last_update_ndd} />} cursor={{ fill: 'transparent' }} />
                            <Legend verticalAlign="top" height={36} wrapperStyle={{fontSize: '12px', color: '#fff'}} />
                            
                                {/* Barra do ano anterior (agora com stackId="prev_year" para forçar a ordem na esquerda) */}
                                <Bar name={`Produção ${year - 1}`} dataKey="prev_total" stackId="prev_year" fill="#546E7A" radius={[3, 3, 0, 0]} label={(props) => <RenderCompLabel {...props} fill="#B0BEC5" />} onClick={handleBarClick} style={{cursor:'pointer'}} />

                                {/* Barra do ano atual (na direita) */}
                                <Bar name={`Produção ${year}`} dataKey="curr_total" stackId="curr_year" fill="#00E5FF" radius={[3, 3, 0, 0]} label={(props) => <RenderCompCurrLabel {...props} />} onClick={handleBarClick} style={{cursor:'pointer'}} />

                                {/* Projeção do ano atual em cima da barra do ano atual */}
                                <Bar dataKey="total_gap" stackId="curr_year" fill="#00E5FF" opacity={0.6} stroke="#fff" strokeDasharray="3 3" radius={[3, 3, 0, 0]} label={(props) => <RenderCompProjLabel {...props} />} style={{pointerEvents: 'none'}} legendType="none" />
                        </BarChart>
                    ) : (
<BarChart data={chartData} onClick={handleBarClick} style={{cursor:'pointer'}} stackOffset={currentView === 'communication' ? 'expand' : 'none'} margin={{top: 20, right: 30, left: 50, bottom: 5}}>
                            <defs><pattern id="stripe" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)"><line x1="0" y="0" x2="0" y2="8" stroke="#FFFFFF" strokeWidth="2" opacity="0.3" /></pattern><mask id="stripe-mask"><rect x="0" y="0" width="100%" height="100%" fill="white" /><rect x="0" y="0" width="100%" height="100%" fill="url(#stripe)" /></mask></defs>
                            <CartesianGrid strokeDasharray="3 3" stroke="#37474F" vertical={false} />
                            <XAxis dataKey="name" stroke="#B0BEC5" tick={{fontSize: 12}} />
                            <YAxis stroke="#B0BEC5" tickFormatter={formatYAxis} tick={{fontSize: 11}} />
                            
                            {/* Repassamos a variável "year" para o Tooltip saber se é ano atual */}
                            <Tooltip content={<DefaultTooltip view={currentView} sourceFilter={source} selectedYear={year} />} cursor={{ fill: 'transparent' }} />
                            
                            {/* --- LINHA COM CLASSE NOVA E POSIÇÃO TOTALMENTE À ESQUERDA --- */}
                            {currentView === 'communication' && showGoalLine && (
                                <ReferenceLine 
                                    className="pulse-goal-line" 
                                    y={0.9} 
                                    stroke="#00E5FF" 
                                    strokeDasharray="5 5" 
                                    strokeWidth={2}
                                    label={{ 
                                        position: 'left',  /* Coloca o texto totalmente antes do Eixo Y */
                                        value: 'META: 90%', 
                                        fill: '#00E5FF', 
                                        fontSize: 12, 
                                        fontWeight: 'bold',
                                        dx: -5,  /* Afasta um pouco do Eixo */
                                        dy: -5   /* Levita o texto para não ficar em cima do pontilhado */
                                    }} 
                                />
                            )}

                            {currentView.startsWith('production') ? (
                                <>
                                <Bar dataKey="pb" stackId="a" fill="#546E7A" animationDuration={800} barSize={55} label={(props) => <RenderPBLabel {...props} />} onClick={handleBarClick} style={{cursor:'pointer'}} />
                                <Bar dataKey="cor" stackId="a" fill="#00E5FF" animationDuration={800} barSize={55} label={(props) => <RenderCorLabel {...props} />} onClick={handleBarClick} style={{cursor:'pointer'}} />
                                <Bar dataKey="pb_gap" stackId="a" fill="#546E7A" opacity={0.6} stroke="#fff" strokeDasharray="3 3" barSize={55} />
                                <Bar dataKey="cor_gap" stackId="a" fill="#00E5FF" opacity={0.6} stroke="#fff" strokeDasharray="3 3" barSize={55} label={(props) => <RenderProjectionLabel {...props} />} />
                                </>
                            ) : (
                                <>
                                <Bar dataKey="connected" stackId="b" fill="#26A69A" animationDuration={800} barSize={55} label={(props) => <RenderCommLabel {...props} type="connected" />} />
                                <Bar dataKey="disconnected" stackId="b" fill="#EF5350" animationDuration={800} barSize={55} label={(props) => <RenderCommLabel {...props} type="disconnected" />} />
                                </>
                            )}
                        </BarChart>
                    )}
                </ResponsiveContainer>
            )}
        </div>

        <footer>
          <div className="footer-left">
            <span style={{ color: '#B0BEC5' }}>Atualizado em:</span>
            <div className="footer-item" onClick={() => open('https://www.ndd.com.br')} style={{cursor: 'pointer'}}><span>NDD:</span> <b>{formatDate(data?.last_update_ndd)}</b></div>
            <div className="separator">|</div>
            <div className="footer-item" onClick={() => open('https://www.canon.com.br')} style={{cursor: 'pointer'}}><span>iW:</span> <b>{formatDate(data?.last_update_iw)}</b></div>
          </div>
          <div className="footer-right">
              {currentView !== 'monitoring' && <>
                  <span className="footer-stat">Empresas: <b>{footerStats.companies.toLocaleString()}</b></span>
                  <span className="separator">|</span>
                  <span className="footer-stat">Equipamentos: <b>{footerStats.equipments.toLocaleString()}</b></span>
                  <span className="separator">|</span>
              </>}
              {(bgLoading || !areCompaniesReady) && <span className="footer-spinner"></span>}
              <span className="status-text">{statusText}</span>
          </div>
        </footer>
      </div>
      )}
    </>
  );
}

export default App;