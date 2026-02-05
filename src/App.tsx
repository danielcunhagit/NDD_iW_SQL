import { useState, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";
import "./App.css";
import { open } from '@tauri-apps/api/shell';

// --- TYPES ---
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

type ViewType = 'production_current' | 'production_compare' | 'communication' | 'monitoring';

const MESES = ["", "Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const fmtMilhar = (val: number) => val > 0 ? val.toLocaleString('pt-BR') : '0';
const formatDate = (dateStr: string | undefined) => { if (!dateStr || dateStr === "N/D") return "N/D"; try { return new Date(dateStr + "T00:00:00").toLocaleDateString('pt-BR'); } catch { return dateStr; } };

const MonitoringView = ({ data }: { data: MonitoringData | null }) => {
    if (!data) return <div style={{display:'flex', height:'100%', alignItems:'center', justifyContent:'center', color:'#B0BEC5'}}>Carregando diagrama...</div>;
    const ProCard = ({ title, value, total, status = "neutral", hasNext = false }: any) => {
        const pct = total > 0 ? Math.round((value / total) * 100) : 0;
        return (
            <div className={`flow-card status-${status} ${hasNext ? 'has-next' : ''} expand`}>
                <div className="card-header"><span className="card-title">{title}</span>{total > 0 && total !== value && <span className="card-pct">{pct}%</span>}</div>
                <div className="card-body"><span className="card-value">{fmtMilhar(value)}</span><span className="card-label">eqp</span></div>
            </div>
        );
    };
    return (
        <div className="monitoring-container">
            <div className="col-level" style={{flex: 0.8}}><ProCard title="Parque Total (MIF)" value={data.mif} status="main" hasNext={true} /></div>
            <div className="col-level">
                <div className="card-group grouped"><ProCard title="Compatíveis" value={data.compatible} total={data.mif} status="good" hasNext={true} /></div>
                <div className="card-group grouped"><ProCard title="Incompatíveis" value={data.not_compatible} total={data.mif} status="bad" /></div>
            </div>
            <div className="col-level">
                <div className="card-group grouped" style={{flexGrow: 1.5}}><ProCard title="Monitorados" value={data.registered} total={data.compatible} status="good" hasNext={true} /></div>
                <div className="card-group grouped" style={{flexGrow: 1}}><ProCard title="Sem Monitoramento" value={data.not_registered} total={data.compatible} status="warn" hasNext={true} /></div>
                <div className="card-group" style={{flexGrow: 0.5, visibility: 'hidden'}}></div> 
            </div>
            <div className="col-level">
                <div className="card-group grouped" style={{flexGrow: 1.5}}>
                    <ProCard title="NDD Print" value={data.ndd} total={data.registered} status="neutral" />
                    <ProCard title="Apenas iW" value={data.iw} total={data.registered} status="neutral" />
                </div>
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
            <div style={{position:'absolute', bottom: 10, right: 20, fontSize: 10, color: '#546E7A'}}>Ref: {formatDate(data.last_date)}</div>
        </div>
    );
};

const RenderPBLabel = ({ x, y, width, height, value, payload }: any) => { if (!payload || !value) return null; const showTotalHere = (payload.cor || 0) === 0; const totalReal = payload.total_prod; return ( <g style={{ pointerEvents: 'none' }}> {height > 12 && <text x={x + width / 2} y={y + height / 2} fill="white" textAnchor="middle" dominantBaseline="middle" fontSize={10} fontWeight="bold">{fmtMilhar(value)}</text>} {showTotalHere && <text x={x + width / 2} y={y - 8} fill="white" textAnchor="middle" fontSize={11} fontWeight="bold">{totalReal?.toLocaleString('pt-BR')}</text>} </g> ); };
const RenderCorLabel = ({ x, y, width, height, value, payload }: any) => { if (!payload || !value) return null; const totalReal = payload.total_prod; return ( <g style={{ pointerEvents: 'none' }}> {height > 12 && <text x={x + width / 2} y={y + height / 2} fill="black" textAnchor="middle" dominantBaseline="middle" fontSize={10} fontWeight="bold">{fmtMilhar(value)}</text>} <text x={x + width / 2} y={y - 8} fill="white" textAnchor="middle" fontSize={11} fontWeight="bold">{totalReal?.toLocaleString('pt-BR')}</text> </g> ); };
const RenderProjectionLabel = ({ x, y, width, value }: any) => { if (!value) return null; return <text x={x + width / 2} y={y - 8} fill="#FFD740" textAnchor="middle" fontSize={11} fontWeight="bold" fontStyle="italic">{value.toLocaleString('pt-BR')}</text>; };
const RenderCommLabel = ({ x, y, width, height, payload, type }: any) => { if (!payload || !payload.total_devs) return null; const qtd = payload[type]; if (!qtd || qtd === 0) return null; const pct = Math.round((qtd / payload.total_devs) * 100); const centerY = y + height / 2; if (height < 14) return null; return ( <g style={{ pointerEvents: 'none' }}> <text x={x + width / 2} y={centerY} fill="white" textAnchor="middle" dominantBaseline="middle" fontSize={11} fontWeight="bold"> <tspan x={x + width / 2} dy={height > 24 ? "-0.5em" : "0"}>{pct}%</tspan> {height > 24 && <tspan x={x + width / 2} dy="1.2em">({fmtMilhar(qtd)})</tspan>} </text> </g> ); };
const RenderCompLabel = ({ x, y, width, value, fill }: any) => { if (!value) return null; return <text x={x + width / 2} y={y - 5} fill={fill} textAnchor="middle" fontSize={10} fontWeight="bold">{fmtMilhar(value)}</text>; };

const DefaultTooltip = ({ active, payload, label, view }: any) => { 
    if (active && payload && payload.length) { 
        const d = payload[0].payload; 
        if (view.startsWith('production') && (d.pb + d.cor) === 0) return null; 
        if (view === 'communication' && d.total_devs === 0) return null; 
        const activeDevices = d.devices || 0; 
        const average = activeDevices > 0 ? Math.round(d.total_prod / activeDevices) : 0; 
        return ( 
            <div style={{ background: '#263238', border: '1px solid #546E7A', padding: '12px', borderRadius: '6px', minWidth: 160, zIndex: 100 }}> 
                <p style={{ fontWeight: 'bold', color: 'white', marginBottom: 8, fontSize: 13, textAlign: 'center' }}>{label}</p> 
                {view.startsWith('production') ? ( 
                    <> 
                        <p style={{color: '#B0BEC5', fontSize: 11, marginBottom: 4, fontWeight: 'bold', borderBottom: '1px solid #37474F'}}>PRODUÇÃO</p> 
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{color:'#546E7A'}}>P&B:</span><span style={{color:'#fff', fontWeight:'bold'}}>{d.pb.toLocaleString()}</span></div> 
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{color:'#00E5FF'}}>Cor:</span><span style={{color:'#fff', fontWeight:'bold'}}>{d.cor.toLocaleString()}</span></div> 
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2, marginBottom: 4 }}> <span style={{color:'#fff'}}>Total:</span><span style={{color:'#fff', fontWeight:'bold'}}>{(d.pb+d.cor).toLocaleString()}</span> </div> 
                        <div style={{ borderTop:'1px solid #546E7A', margin: '4px 0' }}></div> 
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{color:'#B0BEC5'}}>Impressoras produzindo:</span><span style={{color:'#fff', fontWeight:'bold'}}>{activeDevices.toLocaleString()}</span></div> 
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{color:'#B0BEC5'}}>Média de produção por impressora:</span><span style={{color:'#FFD740', fontWeight:'bold'}}>{average.toLocaleString()}</span></div> 
                        {d.total_proj > (d.pb+d.cor) && <p style={{color: '#FFD740', textAlign:'right', marginTop:4, fontSize:11}}>Est: {d.total_proj.toLocaleString()}</p>} 
                    </> 
                ) : ( 
                    <> 
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{color:'#26A69A'}}>ON:</span><span style={{color:'#fff'}}>{d.connected.toLocaleString()} ({d.pct_conn}%)</span></div> 
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{color:'#EF5350'}}>OFF:</span><span style={{color:'#fff'}}>{d.disconnected.toLocaleString()} ({d.pct_disc}%)</span></div> 
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, borderTop:'1px solid #37474F' }}><span style={{color:'#B0BEC5'}}>Total:</span><span style={{color:'#fff', fontWeight:'bold'}}>{d.total_devs.toLocaleString()}</span></div> 
                    </> 
                )} 
            </div> 
        ); 
    } 
    return null; 
};

const ComparisonTooltip = ({ active, payload, label, selectedYear }: any) => { if (active && payload && payload.length >= 2) { const prevData = payload.find((p: any) => p.dataKey === "prev_total"); const currData = payload.find((p: any) => p.dataKey === "curr_total"); if (!prevData || !currData) return null; const prevVal = prevData.value; const currVal = currData.value; const now = new Date(); const currentRealYear = now.getFullYear(); const currentRealMonth = now.getMonth() + 1; const monthIndex = MESES.indexOf(label); const isFutureMonth = selectedYear === currentRealYear && monthIndex > currentRealMonth; let diffDisplay = <></>; if (prevVal > 0) { if (currVal === 0 && isFutureMonth) { diffDisplay = <span style={{color: '#90A4AE', fontStyle: 'italic', fontSize: 11}}>Aguardando dados...</span>; } else { const diffPct = ((currVal - prevVal) / prevVal) * 100; let colorDiff = "#B0BEC5"; let diffText = "Estável"; if (diffPct > 0) { diffText = "Aumento de"; colorDiff = "#00E676"; } else if (diffPct < 0) { diffText = "Diminuição de"; colorDiff = "#EF5350"; } diffDisplay = <span style={{color: colorDiff}}>{diffText} {Math.abs(diffPct).toFixed(2)}%</span>; } } else if (currVal > 0) { diffDisplay = <span style={{color: "#00E676"}}>Novo (100.00%)</span>; } return ( <div style={{ background: '#263238', border: '1px solid #546E7A', padding: '10px', borderRadius: '6px', minWidth: 160, zIndex: 100 }}> <p style={{ fontWeight: 'bold', color: 'white', marginBottom: 8, fontSize: 13, textAlign: 'center', borderBottom: '1px solid #455A64', paddingBottom: 4 }}>{label}</p> <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 12 }}><span style={{color: '#90A4AE'}}>{prevData.name}:</span><span style={{color: '#fff', fontWeight: 'bold'}}>{fmtMilhar(prevVal)}</span></div> <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: 12 }}><span style={{color: '#00E5FF'}}>{currData.name}:</span><span style={{color: '#fff', fontWeight: 'bold'}}>{fmtMilhar(currVal)}</span></div> <div style={{ borderTop: '1px solid #455A64', paddingTop: 6, textAlign: 'center', fontSize: 13, fontWeight: 'bold' }}> {diffDisplay} </div> </div> ); } return null; };

function App() {
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [splashStatus, setSplashStatus] = useState("Iniciando...");
  const [splashProgress, setSplashProgress] = useState(10);
  const [splashError, setSplashError] = useState<string | null>(null);

  const [isLoadingData, setIsLoadingData] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("Processando..."); 
  const [statusText, setStatusText] = useState("");

  const [data, setData] = useState<DashboardData | null>(null);
  const [consolidatedData, setConsolidatedData] = useState<DashboardData | null>(null);
  const [companyCache, setCompanyCache] = useState<Record<string, DashboardData>>({}); 
  const [monitoringData, setMonitoringData] = useState<MonitoringData | null>(null);
  const [bgLoading, setBgLoading] = useState(false);

  const [toast, setToast] = useState<ToastMsg>({ message: '', type: 'info', visible: false });

  const [companyList, setCompanyList] = useState<string[]>([]);
  const [currentView, setCurrentView] = useState<ViewType>('production_current');
  const [year, setYear] = useState(new Date().getFullYear());
  const [source, setSource] = useState("Consolidado");
  const [tempCompany, setTempCompany] = useState(""); 
  const [selectedCompany, setSelectedCompany] = useState("");

  const didInit = useRef(false);

  const showToast = (message: string, type: 'info' | 'success') => {
      setToast({ message, type, visible: true });
      setTimeout(() => setToast(prev => ({ ...prev, visible: false })), 4000);
  };

  const availableYears = useMemo(() => {
      if (!data) return [new Date().getFullYear()];
      const years = new Set<number>();
      data.production.forEach(d => years.add(d.ano));
      data.communication.forEach(d => years.add(d.ano));
      return Array.from(years).sort((a, b) => b - a);
  }, [data]);

  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;

    let unlisten: any;
    let unlistenMonitor: any;

    const startSystem = async () => {
        try {
            unlisten = await listen("splash-status", (event: any) => {
                setSplashStatus(event.payload as string);
                setSplashProgress(prev => Math.min(prev + 10, 95));
            });
            unlistenMonitor = await listen("monitoring-status", (event: any) => {
                setStatusText(event.payload as string);
            });

            // 1. CARREGA ANO ATUAL E ANTERIOR
            const initialData = await invoke<DashboardData>("perform_initial_load");
            
            setSplashProgress(100);
            setSplashStatus("Carregado.");
            setData(initialData);
            setConsolidatedData(initialData);
            setStatusText("Consolidado.");
            
            invoke<string[]>("fetch_companies", { sourceFilter: "Consolidado" }).then(setCompanyList);

            await invoke("finalize_startup");
            setTimeout(() => { setIsInitialLoad(false); }, 300);

            // Toast de status
            const currY = new Date().getFullYear();
            showToast(`Dados de ${currY} e ${currY-1} prontos. Carregando histórico antigo...`, 'info');

            setBgLoading(true);
            setStatusText("Atualizando histórico antigo...");
            
            // 2. BUSCA O RESTANTE DO HISTÓRICO ( < ANO ANTERIOR )
            invoke<DashboardData>("fetch_full_history")
                .then(historyData => {
                    setData(prev => {
                        if (!prev) return historyData;
                        return {
                            ...prev,
                            production: [...prev.production, ...historyData.production],
                            communication: [...prev.communication, ...historyData.communication]
                        };
                    });
                    setConsolidatedData(prev => {
                        if (!prev) return historyData;
                        return {
                            ...prev,
                            production: [...prev.production, ...historyData.production],
                            communication: [...prev.communication, ...historyData.communication]
                        };
                    });
                    setStatusText("Histórico completo.");
                    setBgLoading(false);
                    showToast("Todo o histórico foi carregado.", 'success');
                })
                .catch(console.error);

            invoke<MonitoringData>("fetch_monitoring_data").then(setMonitoringData);

        } catch (err) {
            console.error("ERRO CRÍTICO:", err);
            setSplashError(String(err));
        }
    };
    startSystem();
    return () => { 
        if(unlisten) unlisten();
        if(unlistenMonitor) unlistenMonitor();
    };
  }, []);

  const handleFetchData = async (empresa: string) => {
      if (!empresa) {
          if (consolidatedData) {
              setData(consolidatedData);
              setStatusText("Visão Consolidada restaurada.");
          }
          return;
      }
      if (companyCache[empresa]) {
          setData(companyCache[empresa]);
          setStatusText(`Filtro: ${empresa} (Cache)`);
          return;
      }
      setIsLoadingData(true);
      setLoadingMsg("Preparando filtro...");
      setStatusText("Filtrando...");
      const unlisten = await listen("splash-status", (event: any) => setLoadingMsg(event.payload as string));
      invoke<DashboardData>("fetch_dashboard_data", { company: empresa })
          .then(res => {
              setData(res);
              setCompanyCache(prev => ({ ...prev, [empresa]: res }));
              setStatusText(`Filtro: ${empresa}`);
          })
          .catch(err => {
              console.error(err);
              setStatusText("Erro ao filtrar");
          })
          .finally(() => {
              unlisten(); 
              setTimeout(() => setIsLoadingData(false), 300);
          });
  };

  useEffect(() => { if(!isInitialLoad) { invoke<string[]>("fetch_companies", { sourceFilter: source }).then(setCompanyList); } }, [source]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value; setTempCompany(val);
      const match = companyList.find(c => c.toLowerCase() === val.toLowerCase());
      if (match && match !== selectedCompany) { setSelectedCompany(match); handleFetchData(match); } 
      else if (val === "") { setTempCompany(""); setSelectedCompany(""); handleFetchData(""); }
  };
  const clearCompanyFilter = () => { setTempCompany(""); setSelectedCompany(""); handleFetchData(""); };

  const chartData = useMemo(() => {
    if (!data) return [];
    const grouped = Array.from({ length: 13 }, (_, i) => ({
      name: MESES[i], pb: 0, cor: 0, devices: 0, pb_gap: 0, cor_gap: 0, connected: 0, disconnected: 0, 
      total_devs: 0, total_prod: 0, total_proj: 0, pct_conn: 0, pct_disc: 0, prev_total: 0, curr_total: 0
    }));
    const prevYear = year - 1;
    const filterFn = (d: { source: string }) => {
        if (source === "Consolidado") return true;
        if (source === "NDD") return d.source === "NDD";
        if (source === "iW") return d.source === "IW";
        return false;
    };
    const isProduction = currentView.startsWith('production');
    
    if (isProduction) {
      data.production.filter(filterFn).forEach(d => {
        if (d.ano === year) {
          grouped[d.mes].pb += d.pb; grouped[d.mes].cor += d.cor; grouped[d.mes].devices += d.devices; 
          grouped[d.mes].total_prod += (d.pb + d.cor); grouped[d.mes].curr_total += (d.pb + d.cor);
        }
        if (currentView === 'production_compare' && d.ano === prevYear) grouped[d.mes].prev_total += (d.pb + d.cor);
      });
      let targetMonth = new Date().getFullYear() === year ? new Date().getMonth() + 1 : -1;
      let targetYear = new Date().getFullYear();

      if (data.last_update_ndd && data.last_update_ndd !== "N/D") {
          try {
              const parts = data.last_update_ndd.split('-'); 
              if (parts.length === 3) {
                  targetYear = parseInt(parts[0]);
                  targetMonth = parseInt(parts[1]);
              }
          } catch (e) {}
      }

      if (year === targetYear && data.projection && currentView !== 'production_compare') {
        const cm = targetMonth;
        let estPB = 0, estCor = 0;
        if (source === "Consolidado") { estPB = data.projection.ndd_pb + data.projection.iw_pb; estCor = data.projection.ndd_cor + data.projection.iw_cor; } 
        else if (source === "NDD") { estPB = data.projection.ndd_pb; estCor = data.projection.ndd_cor; } 
        else if (source === "iW") { estPB = data.projection.iw_pb; estCor = data.projection.iw_cor; }
        
        if (cm >= 1 && cm <= 12) {
            grouped[cm].pb_gap = Math.max(0, estPB - grouped[cm].pb); 
            grouped[cm].cor_gap = Math.max(0, estCor - grouped[cm].cor);
            grouped[cm].total_proj = grouped[cm].total_prod + grouped[cm].pb_gap + grouped[cm].cor_gap;
        }
      }
    } else {
      data.communication.filter(filterFn).forEach(d => {
        if (d.ano === year) { grouped[d.mes].connected += d.connected; grouped[d.mes].disconnected += d.disconnected; }
      });
      grouped.forEach(g => {
          g.total_devs = g.connected + g.disconnected;
          if (g.total_devs > 0) { g.pct_conn = Math.round((g.connected/g.total_devs)*100); g.pct_disc = Math.round((g.disconnected/g.total_devs)*100); }
      });
    }
    return grouped.slice(1);
  }, [data, currentView, year, source]);

  const footerStats = useMemo(() => {
      if (!data) return { companies: 0, equipments: 0 };
      if (selectedCompany) { return { companies: 1, equipments: data.total_equipments }; }
      if (currentView === 'monitoring' && monitoringData) { return { companies: data.total_companies, equipments: monitoringData.mif }; }
      const maxEquipments = chartData.reduce((max, curr) => {
          const devs = currentView.startsWith('production') ? curr.devices : curr.total_devs;
          return devs > max ? devs : max;
      }, 0);
      return { companies: companyList.length, equipments: maxEquipments };
  }, [data, monitoringData, currentView, chartData, companyList, selectedCompany]);

  const formatYAxis = (val: number) => currentView === 'communication' ? `${(val * 100).toFixed(0)}%` : `${(val/1000000).toFixed(1)}M`;

  return (
    <>
      {isInitialLoad && (
        <div className="splash-container">
          <div className="splash-top-bar" />
          <div className="splash-icon-box">{splashError ? <div className="splash-error-mark">!</div> : <div className="splash-spinner"></div>}</div>
          <h1 className="splash-title">MONITORAMENTO RPA</h1>
          <p className="splash-status">{splashStatus}</p>
          {!splashError && (<div className="splash-progress-bg"><div className={`splash-progress-fill`} style={{ width: `${splashProgress}%` }}></div></div>)}
          {/* AQUI ESTÁ A MUDANÇA NO BOTÃO DE FECHAR */}
          {splashError && (
            <div className="splash-error-container">
              <p className="splash-error-title">ERRO</p>
              <p className="splash-error-desc" style={{marginBottom: '15px'}}>Falha na conexão. Verifique a VPN.</p>
              <div className="splash-actions">
                <button className="btn-retry" onClick={() => window.location.reload()}>Tentar Novamente</button>
                <button className="btn-exit" onClick={() => invoke("quit_app")}>Fechar</button>
              </div>
            </div>
          )}
          <div className="splash-version">v1.0.0</div>
        </div>
      )}

      {isLoadingData && !isInitialLoad && (
          <div className="loading-modal-overlay">
              <div className="loading-box">
                  <div className="loading-spinner"></div>
                  <div className="loading-text">{loadingMsg}</div>
              </div>
          </div>
      )}

      {toast.visible && (
          <div className={`toast-container ${toast.type}`}>
              <span className="toast-icon">{toast.type === 'success' ? '✓' : 'ℹ'}</span>
              <span>{toast.message}</span>
          </div>
      )}

      {!isInitialLoad && (
      <div className={`container ${isLoadingData ? 'blurred' : ''}`}>
        <header>
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
               <div className="filter-group"><label>Empresa</label><div className="input-wrapper"><input list="companies" placeholder="Todas..." value={tempCompany} onChange={handleInputChange} />{tempCompany && <button className="clear-btn" onClick={clearCompanyFilter}>✕</button>}<datalist id="companies">{companyList.map((c, i) => <option key={i} value={c} />)}</datalist></div></div>
               <div className="filter-group"><label>Ano</label><select value={year} onChange={e => setYear(Number(e.target.value))}>{availableYears.map(y => <option key={y} value={y}>{y}</option>)}</select></div>
               <div className="filter-group"><label>Fonte</label><select value={source} onChange={e => setSource(e.target.value)}><option value="Consolidado">Consolidado</option><option value="NDD">NDD</option><option value="iW">iW</option></select></div>
            </div>
          )}
        </header>

        <div className="chart-frame">
            {currentView === 'monitoring' ? (
                <MonitoringView data={monitoringData} />
            ) : (
                <ResponsiveContainer width="100%" height="100%">
                    {currentView === 'production_compare' ? (
                        <BarChart data={chartData} barGap={2} margin={{top: 20, right: 30, left: 20, bottom: 5}}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#37474F" vertical={false} />
                            <XAxis dataKey="name" stroke="#B0BEC5" tick={{fontSize: 12}} />
                            <YAxis stroke="#B0BEC5" tickFormatter={formatYAxis} tick={{fontSize: 11}} />
                            <Tooltip content={<ComparisonTooltip selectedYear={year} />} cursor={{ fill: 'transparent' }} />
                            <Legend verticalAlign="top" height={36} wrapperStyle={{fontSize: '12px', color: '#fff'}} />
                            <Bar name={`Produção ${year - 1}`} dataKey="prev_total" fill="#546E7A" radius={[3, 3, 0, 0]} label={(props) => <RenderCompLabel {...props} fill="#B0BEC5" />} />
                            <Bar name={`Produção ${year}`} dataKey="curr_total" fill="#00E5FF" radius={[3, 3, 0, 0]} label={(props) => <RenderCompLabel {...props} fill="#fff" />} />
                        </BarChart>
                    ) : (
                        <BarChart data={chartData} stackOffset={currentView === 'communication' ? 'expand' : 'none'} margin={{top: 20, right: 30, left: 20, bottom: 5}}>
                            <defs><pattern id="stripe" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)"><line x1="0" y="0" x2="0" y2="8" stroke="#FFFFFF" strokeWidth="2" opacity="0.3" /></pattern><mask id="stripe-mask"><rect x="0" y="0" width="100%" height="100%" fill="white" /><rect x="0" y="0" width="100%" height="100%" fill="url(#stripe)" /></mask></defs>
                            <CartesianGrid strokeDasharray="3 3" stroke="#37474F" vertical={false} />
                            <XAxis dataKey="name" stroke="#B0BEC5" tick={{fontSize: 12}} />
                            <YAxis stroke="#B0BEC5" tickFormatter={formatYAxis} tick={{fontSize: 11}} />
                            <Tooltip content={<DefaultTooltip view={currentView} />} cursor={{ fill: 'transparent' }} />
                            {currentView.startsWith('production') ? (
                                <>
                                <Bar dataKey="pb" stackId="a" fill="#546E7A" animationDuration={800} barSize={55} label={(props) => <RenderPBLabel {...props} />} />
                                <Bar dataKey="cor" stackId="a" fill="#00E5FF" animationDuration={800} barSize={55} label={(props) => <RenderCorLabel {...props} />} />
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
              {bgLoading && <span className="footer-spinner"></span>}
              <span className="status-text">{statusText}</span>
          </div>
        </footer>
      </div>
      )}
    </>
  );
}

export default App;