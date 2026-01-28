import { useState, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
// Removida importação de 'process' para evitar erro de permissão
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
}

const MESES = ["", "Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const fmtMilhar = (val: number) => val > 0 ? val.toLocaleString('pt-BR') : '';
const formatDate = (dateStr: string | undefined) => {
    if (!dateStr || dateStr === "N/D") return "N/D";
    try {
        const d = new Date(dateStr);
        return isNaN(d.getTime()) ? dateStr : d.toLocaleDateString('pt-BR');
    } catch { return dateStr; }
};

// --- CHART LABELS (MANTIDOS) ---
const RenderPBLabel = ({ x, y, width, height, value, payload }: any) => {
    if (!payload || !value) return null;
    const showTotalHere = (payload.cor || 0) === 0;
    const totalReal = payload.total_prod;
    return (
        <g style={{ pointerEvents: 'none' }}>
            {height > 12 && <text x={x + width / 2} y={y + height / 2} fill="white" textAnchor="middle" dominantBaseline="middle" fontSize={10} fontWeight="bold">{fmtMilhar(value)}</text>}
            {showTotalHere && <text x={x + width / 2} y={y - 8} fill="white" textAnchor="middle" fontSize={11} fontWeight="bold">{totalReal?.toLocaleString('pt-BR')}</text>}
        </g>
    );
};
const RenderCorLabel = ({ x, y, width, height, value, payload }: any) => {
    if (!payload || !value) return null;
    const totalReal = payload.total_prod;
    return (
        <g style={{ pointerEvents: 'none' }}>
            {height > 12 && <text x={x + width / 2} y={y + height / 2} fill="black" textAnchor="middle" dominantBaseline="middle" fontSize={10} fontWeight="bold">{fmtMilhar(value)}</text>}
            <text x={x + width / 2} y={y - 8} fill="white" textAnchor="middle" fontSize={11} fontWeight="bold">{totalReal?.toLocaleString('pt-BR')}</text>
        </g>
    );
};
const RenderProjectionLabel = ({ x, y, width, value }: any) => {
    if (!value) return null;
    return <text x={x + width / 2} y={y - 8} fill="#FFD740" textAnchor="middle" fontSize={11} fontWeight="bold" fontStyle="italic">{value.toLocaleString('pt-BR')}</text>;
};
const RenderCommLabel = ({ x, y, width, height, payload, type }: any) => {
    if (!payload || !payload.total_devs) return null;
    const qtd = payload[type];
    if (!qtd || qtd === 0) return null;
    const pct = Math.round((qtd / payload.total_devs) * 100);
    const centerY = y + height / 2;
    if (height < 14) return null;
    return (
        <g style={{ pointerEvents: 'none' }}>
            <text x={x + width / 2} y={centerY} fill="white" textAnchor="middle" dominantBaseline="middle" fontSize={11} fontWeight="bold">
                <tspan x={x + width / 2} dy={height > 24 ? "-0.5em" : "0"}>{pct}%</tspan>
                {height > 24 && <tspan x={x + width / 2} dy="1.2em">({fmtMilhar(qtd)})</tspan>}
            </text>
        </g>
    );
};
const RenderCompLabel = ({ x, y, width, value, fill }: any) => {
    if (!value) return null;
    return <text x={x + width / 2} y={y - 5} fill={fill} textAnchor="middle" fontSize={10} fontWeight="bold">{fmtMilhar(value)}</text>;
};

// --- TOOLTIPS (MANTIDOS) ---
const DefaultTooltip = ({ active, payload, label, view }: any) => {
    if (active && payload && payload.length) {
      const d = payload[0].payload;
      if (view === 'production' && (d.pb + d.cor) === 0) return null;
      if (view === 'communication' && d.total_devs === 0) return null;
      const activeDevices = d.devices || 0;
      const average = activeDevices > 0 ? Math.round(d.total_prod / activeDevices) : 0;
      return (
        <div style={{ background: '#263238', border: '1px solid #546E7A', padding: '12px', borderRadius: '6px', minWidth: 160, zIndex: 100 }}>
          <p style={{ fontWeight: 'bold', color: 'white', marginBottom: 8, fontSize: 13, textAlign: 'center' }}>{label}</p>
          {view === 'production' ? (
            <>
              <p style={{color: '#B0BEC5', fontSize: 11, marginBottom: 4, fontWeight: 'bold', borderBottom: '1px solid #37474F'}}>PRODUÇÃO</p>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{color:'#546E7A'}}>P&B:</span><span style={{color:'#fff', fontWeight:'bold'}}>{d.pb.toLocaleString()}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{color:'#00E5FF'}}>Cor:</span><span style={{color:'#fff', fontWeight:'bold'}}>{d.cor.toLocaleString()}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2, marginBottom: 4 }}>
                  <span style={{color:'#fff'}}>Total:</span><span style={{color:'#fff', fontWeight:'bold'}}>{(d.pb+d.cor).toLocaleString()}</span>
              </div>
              <div style={{ borderTop:'1px solid #546E7A', margin: '4px 0' }}></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{color:'#B0BEC5'}}>Imp:</span><span style={{color:'#fff', fontWeight:'bold'}}>{activeDevices.toLocaleString()}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{color:'#B0BEC5'}}>Média:</span><span style={{color:'#FFD740', fontWeight:'bold'}}>{average.toLocaleString()}</span></div>
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

const ComparisonTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length >= 2) {
        const prevData = payload.find((p: any) => p.dataKey === "prev_total");
        const currData = payload.find((p: any) => p.dataKey === "curr_total");
        if (!prevData || !currData) return null;
        const prevVal = prevData.value;
        const currVal = currData.value;
        if (prevVal === 0 && currVal === 0) return null;
        let diffPct = 0; let diffSignal = ""; let colorDiff = "#B0BEC5";
        if (prevVal > 0) {
            diffPct = Math.round(((currVal - prevVal) / prevVal) * 100);
            if (diffPct > 0) { diffSignal = "+"; colorDiff = "#00E676"; } else if (diffPct < 0) { colorDiff = "#EF5350"; }
        } else if (currVal > 0) { diffSignal = "+"; diffPct = 100; colorDiff = "#00E676"; }
        return (
            <div style={{ background: '#263238', border: '1px solid #546E7A', padding: '10px', borderRadius: '6px', minWidth: 160, zIndex: 100 }}>
                <p style={{ fontWeight: 'bold', color: 'white', marginBottom: 8, fontSize: 13, textAlign: 'center', borderBottom: '1px solid #455A64', paddingBottom: 4 }}>{label}</p>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 12 }}><span style={{color: '#90A4AE'}}>{prevData.name}:</span><span style={{color: '#fff', fontWeight: 'bold'}}>{fmtMilhar(prevVal)}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: 12 }}><span style={{color: '#00E5FF'}}>{currData.name}:</span><span style={{color: '#fff', fontWeight: 'bold'}}>{fmtMilhar(currVal)}</span></div>
                <div style={{ borderTop: '1px solid #455A64', paddingTop: 6, textAlign: 'center', fontSize: 13, fontWeight: 'bold' }}><span style={{color: colorDiff}}>{diffSignal}{diffPct}%</span></div>
            </div>
        );
    }
    return null;
  };

function App() {
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [splashStatus, setSplashStatus] = useState("Iniciando...");
  const [splashProgress, setSplashProgress] = useState(5);
  const [splashError, setSplashError] = useState<string | null>(null);

  const [isLoadingData, setIsLoadingData] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("Processando..."); 
  const [statusText, setStatusText] = useState("");

  const [data, setData] = useState<DashboardData | null>(null);
  const [companyList, setCompanyList] = useState<string[]>([]);
  const [view, setView] = useState<'production' | 'communication'>('production');
  const [year, setYear] = useState(new Date().getFullYear());
  const [source, setSource] = useState("Consolidado");
  const [tempCompany, setTempCompany] = useState(""); 
  const [selectedCompany, setSelectedCompany] = useState("");
  const [isComparisonMode, setIsComparisonMode] = useState(false);

  const didInit = useRef(false);

  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;

    let unlisten: any;
    const startSystem = async () => {
        try {
            unlisten = await listen("splash-status", (event: any) => {
                const msg = event.payload as string;
                setSplashStatus(prev => msg !== prev ? msg : prev);
                
                let nextProgress = 0;
                if (msg.includes("Iniciando")) nextProgress = 10;
                else if (msg.includes("Produção")) nextProgress = 40;
                else if (msg.includes("Comunicação")) nextProgress = 65;
                else if (msg.includes("estatísticas") || msg.includes("Cálculos")) nextProgress = 85;
                else if (msg.includes("Pronto") || msg.includes("Concluído")) nextProgress = 100;
                
                setSplashProgress(prev => Math.max(prev, nextProgress));
            });

            await invoke("perform_initial_load");
            setSplashProgress(100);
            setSplashStatus("Carregado.");

            const cachedData = await invoke<DashboardData>("fetch_dashboard_data", { company: null });
            const comps = await invoke<string[]>("fetch_companies", { sourceFilter: "Consolidado" });
            
            setData(cachedData);
            setCompanyList(comps);
            setStatusText("Sistema online");

            await invoke("finalize_startup");
            setTimeout(() => { setIsInitialLoad(false); }, 500);

        } catch (err) {
            console.error(err);
            setSplashError(String(err));
        }
    };
    startSystem();
    return () => { if(unlisten) unlisten(); };
  }, []);

  const handleFetchData = async (empresa: string) => {
      setIsLoadingData(true);
      setLoadingMsg("Buscando dados...");
      setStatusText("Atualizando dados...");

      const unlisten = await listen("splash-status", (event: any) => {
          setLoadingMsg(event.payload as string);
      });
      
      invoke<DashboardData>("fetch_dashboard_data", { company: empresa })
          .then(res => {
              setData(res);
              setStatusText("Dados atualizados com sucesso");
          })
          .catch(err => {
              console.error(err);
              setStatusText("Erro ao atualizar");
          })
          .finally(() => {
              unlisten(); 
              setTimeout(() => setIsLoadingData(false), 300);
          });
  };

  useEffect(() => {
      if(!isInitialLoad) {
          invoke<string[]>("fetch_companies", { sourceFilter: source })
            .then(list => setCompanyList(list))
            .catch(console.error);
      }
  }, [source]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setTempCompany(val);
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
    if (view === 'production') {
      data.production.filter(filterFn).forEach(d => {
        if (d.ano === year) {
          grouped[d.mes].pb += d.pb; grouped[d.mes].cor += d.cor; grouped[d.mes].devices += d.devices; 
          grouped[d.mes].total_prod += (d.pb + d.cor); grouped[d.mes].curr_total += (d.pb + d.cor);
        }
        if (isComparisonMode && d.ano === prevYear) grouped[d.mes].prev_total += (d.pb + d.cor);
      });
      if (year === new Date().getFullYear() && data.projection && !isComparisonMode) {
        const cm = new Date().getMonth() + 1;
        let estPB = 0, estCor = 0;
        if (source === "Consolidado") { estPB = data.projection.ndd_pb + data.projection.iw_pb; estCor = data.projection.ndd_cor + data.projection.iw_cor; } 
        else if (source === "NDD") { estPB = data.projection.ndd_pb; estCor = data.projection.ndd_cor; } 
        else if (source === "iW") { estPB = data.projection.iw_pb; estCor = data.projection.iw_cor; }
        grouped[cm].pb_gap = Math.max(0, estPB - grouped[cm].pb); grouped[cm].cor_gap = Math.max(0, estCor - grouped[cm].cor);
        grouped[cm].total_proj = grouped[cm].total_prod + grouped[cm].pb_gap + grouped[cm].cor_gap;
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
  }, [data, view, year, source, isComparisonMode]);

  const footerStats = useMemo(() => {
      if (!data) return { companies: 0, equipments: 0 };
      const currentYear = new Date().getFullYear();
      let totalEquipments = 0;

      if (view === 'production') {
          if (year === currentYear) {
              totalEquipments = chartData.reduce((acc, curr) => acc + (curr.devices || 0), 0);
          } else {
              const validMonths = chartData.filter(d => d.devices > 0).length;
              const sumDevices = chartData.reduce((acc, curr) => acc + (curr.devices || 0), 0);
              totalEquipments = validMonths > 0 ? Math.round(sumDevices / validMonths) : 0;
          }
      } else {
          if (year === currentYear) {
             totalEquipments = chartData.reduce((acc, curr) => acc + (curr.total_devs || 0), 0);
          } else {
             const validMonths = chartData.filter(d => d.total_devs > 0).length;
             const sumDevices = chartData.reduce((acc, curr) => acc + (curr.total_devs || 0), 0);
             totalEquipments = validMonths > 0 ? Math.round(sumDevices / validMonths) : 0;
          }
      }

      return { companies: companyList.length, equipments: totalEquipments };
  }, [chartData, companyList, view, data, year]);

  const availableYears = data ? Array.from(new Set([...data.production.map(d => d.ano), ...data.communication.map(d => d.ano)])).sort((a, b) => b - a) : [new Date().getFullYear()];
  const formatYAxis = (val: number) => view === 'communication' ? `${(val * 100).toFixed(0)}%` : `${(val/1000000).toFixed(1)}M`;

  return (
    <>
      {isInitialLoad && (
        <div className="splash-container">
          <div className="splash-top-bar" />
          <div className="splash-icon-box">{splashError ? <div className="splash-error-mark">!</div> : <div className="splash-spinner"></div>}</div>
          <h1 className="splash-title">MONITORAMENTO RPA</h1>
          {!splashError && <p className="splash-status">{splashStatus}</p>}
          
          {!splashError && (
              <div className="splash-progress-bg">
                  <div className={`splash-progress-fill`} style={{ width: `${splashProgress}%` }}></div>
              </div>
          )}
          
          {splashError && (
              <div className="splash-error-container">
                 <p className="splash-error-title">FALHA NA CONEXÃO</p>
                 <p className="splash-error-desc">
                    Não foi possível acessar o banco de dados.<br/>
                    <b>Verifique se a VPN está conectada.</b>
                 </p>
                 
                 <div className="splash-actions">
                     <button className="btn-retry" onClick={() => window.location.reload()}>Tentar Novamente</button>
                     <button className="btn-exit" onClick={() => invoke("quit_app")}>Sair do Programa</button>
                 </div>
              </div>
          )}
          
          <div className="splash-version">v1.0.0 • Rust + SQLx</div>
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

      {!isInitialLoad && (
      <div className={`container ${isLoadingData ? 'blurred' : ''}`}>
        
        <header>
          <div className="left-controls">
            <div className="view-selector">
              <div className="btn-group-prod">
                  <button onClick={() => { setView('production'); setIsComparisonMode(false); }} className={view === 'production' && !isComparisonMode ? 'active' : ''}>Produção</button>
                  <button onClick={() => { setView('production'); setIsComparisonMode(!isComparisonMode); }} className={isComparisonMode ? 'toggle-active' : ''} title="Comparar com ano anterior">Ano a Ano</button>
              </div>
              <div className="btn-divider"></div>
              <button onClick={() => setView('communication')} className={view === 'communication' ? 'active' : ''}>Comunicação</button>
            </div>
          </div>
          
          <h2>{view === 'production' ? (isComparisonMode ? `Comparativo ${year} vs ${year-1}` : 'Visão Geral de Produção') : 'Status de Comunicação'}</h2>
          
          <div className="filters">
            <div className="filter-group">
               <label>Empresa</label>
               <div className="input-wrapper">
                   <input list="companies" placeholder="Todas..." value={tempCompany} onChange={handleInputChange} />
                   {tempCompany && <button className="clear-btn" onClick={clearCompanyFilter}>✕</button>}
                   <datalist id="companies">{companyList.map((c, i) => <option key={i} value={c} />)}</datalist>
               </div>
            </div>
            <div className="filter-group"><label>Ano</label><select value={year} onChange={e => setYear(Number(e.target.value))}>{availableYears.map(y => <option key={y} value={y}>{y}</option>)}</select></div>
            <div className="filter-group"><label>Fonte</label><select value={source} onChange={e => setSource(e.target.value)}><option value="Consolidado">Consolidado</option><option value="NDD">NDD</option><option value="iW">iW</option></select></div>
          </div>
        </header>

        <div className="chart-frame">
          <ResponsiveContainer width="100%" height="100%">
            {isComparisonMode && view === 'production' ? (
                <BarChart data={chartData} barGap={2}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#37474F" vertical={false} />
                    <XAxis dataKey="name" stroke="#B0BEC5" tick={{fontSize: 12}} />
                    <YAxis stroke="#B0BEC5" tickFormatter={formatYAxis} tick={{fontSize: 11}} />
                    <Tooltip content={<ComparisonTooltip />} cursor={{ fill: 'transparent' }} />
                    <Legend verticalAlign="top" height={36} wrapperStyle={{fontSize: '12px', color: '#fff'}} />
                    <Bar name={`Produção ${year - 1}`} dataKey="prev_total" fill="#546E7A" radius={[3, 3, 0, 0]} label={(props) => <RenderCompLabel {...props} fill="#B0BEC5" />} />
                    <Bar name={`Produção ${year}`} dataKey="curr_total" fill="#00E5FF" radius={[3, 3, 0, 0]} label={(props) => <RenderCompLabel {...props} fill="#fff" />} />
                </BarChart>
            ) : (
                <BarChart data={chartData} stackOffset={view === 'communication' ? 'expand' : 'none'}>
                    <defs>
                        <pattern id="stripe" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)"><line x1="0" y="0" x2="0" y2="8" stroke="#FFFFFF" strokeWidth="2" opacity="0.3" /></pattern>
                        <mask id="stripe-mask"><rect x="0" y="0" width="100%" height="100%" fill="white" /><rect x="0" y="0" width="100%" height="100%" fill="url(#stripe)" /></mask>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#37474F" vertical={false} />
                    <XAxis dataKey="name" stroke="#B0BEC5" tick={{fontSize: 12}} />
                    <YAxis stroke="#B0BEC5" tickFormatter={formatYAxis} tick={{fontSize: 11}} />
                    <Tooltip content={<DefaultTooltip view={view} />} cursor={{ fill: 'transparent' }} />
                    {view === 'production' ? (
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
        </div>

        <footer>
          <div className="footer-left">
            <span style={{ color: '#B0BEC5' }}>Atualizado em:</span>
            <div className="footer-item" onClick={() => open('https://www.ndd.com.br')} style={{cursor: 'pointer'}}><span>NDD:</span> <b>{formatDate(data?.last_update_ndd)}</b></div>
            <div className="separator">|</div>
            <div className="footer-item" onClick={() => open('https://www.canon.com.br')} style={{cursor: 'pointer'}}><span>iW:</span> <b>{formatDate(data?.last_update_iw)}</b></div>
          </div>
          <div className="footer-right">
              <span className="footer-stat">Empresas: <b>{footerStats.companies}</b></span>
              <span className="separator">|</span>
              <span className="footer-stat">Equipamentos: <b>{footerStats.equipments.toLocaleString()}</b></span>
              <span className="separator">|</span>
              <span className="status-text">{statusText}</span>
          </div>
        </footer>
      </div>
      )}
    </>
  );
}

export default App;