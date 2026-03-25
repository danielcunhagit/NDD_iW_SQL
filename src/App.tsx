import { useState, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import { save, ask } from "@tauri-apps/api/dialog";
import { checkUpdate, installUpdate } from "@tauri-apps/api/updater";
import { relaunch } from "@tauri-apps/api/process";
import { writeTextFile } from "@tauri-apps/api/fs";
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, ReferenceLine } from "recharts";
import "./App.css";
import { Info, Cloud, HardDrive, RefreshCw, Database, TrendingUp, Activity, Target, Bell, Download, Check } from "lucide-react";


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

interface MonitoringCompanySummary {
    empresa: string; mif: number; compatible: number; not_compatible: number;
    registered: number; not_registered: number; ndd: number; iw: number;
    possible_canon: number; possible_inter: number; not_possible: number;
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
const fmtMilhar = (val: number) => (val !== 0 && val != null) ? val.toLocaleString('pt-BR') : '0';
const formatDate = (dateStr: string | undefined) => { if (!dateStr || dateStr === "N/D") return "N/D"; try { return new Date(dateStr + "T00:00:00").toLocaleDateString('pt-BR'); } catch { return dateStr; } };

// --- CALCULADOR DE SAÚDE DAS DATAS ---
const getDateStatusColor = (dbDateIso: string | undefined, targetIso: string) => {
    if (!dbDateIso || dbDateIso === "N/D" || !targetIso) return '#EF5350'; // Vermelho (Erro/Sem Dado)
    if (dbDateIso >= targetIso) return '#00E676'; // Verde (Atualizado)
    
    // Se for mais velho, calcula a diferença em dias
    const dbDate = new Date(dbDateIso + "T00:00:00");
    const targetDate = new Date(targetIso + "T00:00:00");
    const diffTime = targetDate.getTime() - dbDate.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    if (diffDays <= 7) return '#FFD740'; // Amarelo (Atraso aceitável, até 7 dias)
    return '#EF5350'; // Vermelho (Muito antigo, > 7 dias)
};

// ... (MonitoringView, RenderLabels e Tooltips MANTIDOS IGUAIS para economizar espaço aqui, mas devem estar no arquivo) ...
// CÓPIA DOS COMPONENTES VISUAIS (Mantenha os que você já tem: MonitoringView, RenderPBLabel, DefaultTooltip, etc)
const MonitoringView = ({ 
    data, 
    dashboardData, 
    companySummaries, 
    isLoadingSummaries,
    showToast
}: { 
    data: MonitoringData | null;
    dashboardData: DashboardData | null;
    companySummaries: MonitoringCompanySummary[];
    isLoadingSummaries: boolean;
    showToast: (msg: string, type: 'info' | 'success') => void;
}) => {
    const [exportStatus, setExportStatus] = useState<'idle' | 'success'>('idle');
    const [isDialogOpening, setIsDialogOpening] = useState(false);
    const [targetStr, setTargetStr] = useState<string>("82.0");
    const [showEvolution, setShowEvolution] = useState(false);
    const [evolutionOffset, setEvolutionOffset] = useState(0);
    const [activeDetailFilter, setActiveDetailFilter] = useState<keyof MonitoringCompanySummary | null>(null);

    // Estados de ordenação da tabela modal
    const [modalSortKey, setModalSortKey] = useState<keyof MonitoringCompanySummary | 'qtde' | 'plataformas'>('qtde');
    const [modalSortDesc, setModalSortDesc] = useState(true);

    // EFEITO: Sempre que abrir um card novo, reseta a ordenação
    useEffect(() => {
        setModalSortKey('qtde');
        setModalSortDesc(true);
    }, [activeDetailFilter]);

    // O useEffect que fazia o invoke() sumiu daqui, pois o App agora faz isso!

    // Lógica da Tabela de Evolução Mensal...
    // Lógica da Tabela de Evolução Mensal (ATUALIZADA PARA NAVEGAÇÃO)
    const evolutionData = useMemo(() => {
        if (!dashboardData || !dashboardData.communication.length) return null;
        const monthsMap: Record<string, { ndd: number, iw: number, total: number, ano: number, mes: number }> = {};
        
        dashboardData.communication.forEach(r => {
            const key = `${r.ano}-${String(r.mes).padStart(2, '0')}`;
            if (!monthsMap[key]) monthsMap[key] = { ndd: 0, iw: 0, total: 0, ano: r.ano, mes: r.mes };
            const devCount = r.connected + r.disconnected;
            if (r.source === 'NDD') monthsMap[key].ndd += devCount;
            if (r.source === 'IW') monthsMap[key].iw += devCount;
            monthsMap[key].total += devCount;
        });
        
        const sortedKeys = Object.keys(monthsMap).sort((a, b) => b.localeCompare(a));
        if (sortedKeys.length < 2) return null; // Precisa de pelo menos 2 meses no banco

        // Garante que a navegação não passe dos limites
        const maxOffset = sortedKeys.length - 2;
        const safeOffset = Math.min(evolutionOffset, maxOffset);

        const curr = monthsMap[sortedKeys[safeOffset]];
        const prev = monthsMap[sortedKeys[safeOffset + 1]];
        
        const diffNdd = curr.ndd - prev.ndd; 
        const diffIw = curr.iw - prev.iw; 
        const diffTotal = curr.total - prev.total;
        const pctNdd = prev.ndd > 0 ? (diffNdd / prev.ndd) * 100 : 0; 
        const pctIw = prev.iw > 0 ? (diffIw / prev.iw) * 100 : 0; 
        const pctTotal = prev.total > 0 ? (diffTotal / prev.total) * 100 : 0;
        
        return { 
            curr, prev, diffNdd, diffIw, diffTotal, pctNdd, pctIw, pctTotal,
            canGoBack: safeOffset < maxOffset, // Tem meses mais antigos?
            canGoForward: safeOffset > 0       // Tem meses mais recentes?
        };
    }, [dashboardData, evolutionOffset]);

    if (!data) return <div style={{display:'flex', height:'100%', alignItems:'center', justifyContent:'center', color:'#B0BEC5'}}>Carregando diagrama...</div>;

    // Cálculos do Header de Metas
    const monitorados = data.registered;
    const faltaMonitorar = data.possible_canon + data.possible_inter; 
    const totalBaseMeta = monitorados + faltaMonitorar;
    const targetPct = parseFloat(targetStr) || 0;
    const resultPct = totalBaseMeta > 0 ? (monitorados / totalBaseMeta) * 100 : 0;
    const isTargetMet = resultPct >= targetPct;
    const targetQtd = Math.ceil(totalBaseMeta * (targetPct / 100));
    const qtdeAMais = targetQtd > monitorados ? targetQtd - monitorados : 0;

    // --- LÓGICA DE ORDENAÇÃO ATUALIZADA ---
    const getFilteredDetails = () => {
        if (!activeDetailFilter || !companySummaries.length) return [];
        return companySummaries
            .filter(c => (c[activeDetailFilter] as number) > 0) // Mostra só empresas que tem >0 na métrica
            .sort((a, b) => {
                let valA: any;
                let valB: any;

                // Define os valores que serão comparados dependendo da coluna clicada
                if (modalSortKey === 'qtde') {
                    valA = a[activeDetailFilter];
                    valB = b[activeDetailFilter];
                } else if (modalSortKey === 'plataformas') {
                    // Ordena pela quantidade de plataformas (2=Ambas, 1=Uma, 0=Nenhuma)
                    valA = (a.ndd > 0 ? 1 : 0) + (a.iw > 0 ? 1 : 0);
                    valB = (b.ndd > 0 ? 1 : 0) + (b.iw > 0 ? 1 : 0);
                } else {
                    valA = a[modalSortKey];
                    valB = b[modalSortKey];
                }

                if (valA < valB) return modalSortDesc ? 1 : -1;
                if (valA > valB) return modalSortDesc ? -1 : 1;
                return 0;
            });
    };

    const detailsList = getFilteredDetails();
    const filterNames: Record<string, string> = { mif: "Parque Total", compatible: "Compatíveis", not_compatible: "Incompatíveis", registered: "Monitorados", not_registered: "Sem Monitoramento", ndd: "NDD Print", iw: "iW Remote", possible_canon: "Oportunidades Canon", possible_inter: "Oportunidades Inter", not_possible: "Não Possível" };

    // Função para alterar a ordenação ao clicar no cabeçalho
    const handleModalSort = (key: keyof MonitoringCompanySummary | 'qtde' | 'plataformas') => {
        if (modalSortKey === key) {
            setModalSortDesc(!modalSortDesc); // Inverte se clicou na mesma
        } else {
            setModalSortKey(key);
            setModalSortDesc(true); // Se clicou em uma nova, começa decrescente
        }
    };

    // --- LÓGICA DE EXPORTAÇÃO EXCEL (CSV) ---
    const handleExportExcel = async () => {
        if (!activeDetailFilter || !detailsList.length) return;

        try {
            // ---> NOVA MÁGICA VISUAL AQUI <---
            // Avisa o React que a janela do sistema vai abrir. 
            // O CSS vai usar isso para manter o botão esticado e animando.
            setIsDialogOpening(true);

            // 1. Abre a janela nativa para o usuário escolher onde salvar (A execução pausa aqui!)
            const filePath = await save({
                title: 'Exportar para Excel',
                defaultPath: `Monitoramento_${filterNames[activeDetailFilter]}_v3.csv`,
                filters: [{ name: 'Arquivo Excel (CSV)', extensions: ['csv'] }]
            });

            // O código só continua a partir daqui QUANDO O USUÁRIO FECHAR A JANELA (clicando em Salvar ou Cancelar)

            // ---> RETIRA O ESTADO DE ESPERA <---
            setIsDialogOpening(false);

            if (!filePath) return; // Usuário fechou a janela sem salvar

            // 2. Monta o conteúdo (Uso de BOM para Excel Brasileiro)
            let csvContent = '\uFEFF';
            csvContent += `Empresa;Qtde (${filterNames[activeDetailFilter]});Parque Total (MIF);Monitoradas;Nao Monitoradas;Plataforma NDD;Plataforma iW\n`;

            // 3. Monta as Linhas da Tabela
            detailsList.forEach(c => {
                const pctMonitorada = c.mif > 0 ? Math.round((c.registered / c.mif) * 100) : 0;
                const pctNaoMonitorada = c.mif > 0 ? Math.round((c.not_registered / c.mif) * 100) : 0;
                
                const row = [
                    `"${c.empresa}"`,
                    c[activeDetailFilter],
                    c.mif,
                    `"${c.registered} (${pctMonitorada}%)"`,
                    `"${c.not_registered} (${pctNaoMonitorada}%)"`,
                    c.ndd,
                    c.iw
                ].join(';');
                
                csvContent += row + '\n';
            });

            // 4. Grava o arquivo fisicamente no disco e DISPARA A ANIMAÇÃO DE SUCESSO!
            await writeTextFile(filePath, csvContent);
            
            setExportStatus('success');
            showToast("Tabela exportada com sucesso!", "success");
            
            // Volta para o ícone padrão após 2.5 segundos
            setTimeout(() => setExportStatus('idle'), 2500);

        } catch (error) {
            console.error("Erro ao exportar:", error);
            // Garante que o estado de espera saia mesmo se houver erro
            setIsDialogOpening(false); 
            showToast("Erro ao tentar salvar o arquivo.", "info");
        }
    };

    const ProCard = ({ id, title, value, total, status = "neutral", hasNext = false }: any) => {
        const pct = total > 0 ? Math.round((value / total) * 100) : 0;
        return (
            <div 
                className={`flow-card status-${status} ${hasNext ? 'has-next' : ''} expand card-clickable`} 
                onClick={() => setActiveDetailFilter(id)} 
                title={`Clique para ver as empresas com equipamentos: ${title}`}
            >
                <div className="card-header"><span className="card-title">{title}</span>{total > 0 && total !== value && <span className="card-pct">{pct}%</span>}</div>
                <div className="card-body"><span className="card-value">{fmtMilhar(value)}</span><span className="card-label">eqp</span></div>
            </div>
        );
    };

    return (
        <div style={{display: 'flex', flexDirection: 'column', height: '100%', width: '100%'}}>
            
{/* --- MODAL DA TABELA DE EVOLUÇÃO (COM NAVEGAÇÃO) --- */}
            {showEvolution && evolutionData && (
                <div className="about-overlay" onClick={() => setShowEvolution(false)}>
                    <div className="about-box" style={{width: '600px', maxWidth: '90%'}} onClick={e => e.stopPropagation()}>
                        
                        {/* Cabeçalho com Botões de Navegação */}
                        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5}}>
                            <h2 className="about-title" style={{marginBottom: 0}}>Evolução de Monitorados</h2>
                            <div className="month-nav" style={{display: 'flex', gap: 10}}>
                                <button 
                                    className="nav-btn" 
                                    disabled={!evolutionData.canGoBack} 
                                    onClick={() => setEvolutionOffset(prev => prev + 1)} 
                                    title="Comparar com meses mais antigos"
                                >{'<'}</button>
                                <button 
                                    className="nav-btn" 
                                    disabled={!evolutionData.canGoForward} 
                                    onClick={() => setEvolutionOffset(prev => prev - 1)} 
                                    title="Avançar para meses recentes"
                                >{'>'}</button>
                            </div>
                        </div>
                        <p className="about-version" style={{marginTop: 0, marginBottom: 15}}>Comparativo do mês selecionado vs mês anterior</p>
                        
                        <table className="evolution-table">
                            <thead>
                                <tr><th>Mês</th><th>NDD</th><th>iW</th><th>Total</th></tr>
                            </thead>
                            <tbody>
                                <tr>
                                    <td className="row-header">{MESES[evolutionData.prev.mes]} / {evolutionData.prev.ano}</td>
                                    <td>{fmtMilhar(evolutionData.prev.ndd)}</td><td>{fmtMilhar(evolutionData.prev.iw)}</td>
                                    <td style={{fontWeight: 'bold'}}>{fmtMilhar(evolutionData.prev.total)}</td>
                                </tr>
                                <tr style={{background: 'rgba(0, 229, 255, 0.05)'}}>
                                    <td className="row-header">{MESES[evolutionData.curr.mes]} / {evolutionData.curr.ano}</td>
                                    <td>{fmtMilhar(evolutionData.curr.ndd)}</td><td>{fmtMilhar(evolutionData.curr.iw)}</td>
                                    <td style={{fontWeight: 'bold'}}>{fmtMilhar(evolutionData.curr.total)}</td>
                                </tr>
                                <tr>
                                    <td className="row-header">Diferença</td>
                                    <td className={evolutionData.diffNdd >= 0 ? 'diff-pos' : 'diff-neg'}>{evolutionData.diffNdd > 0 ? '+' : ''}{fmtMilhar(evolutionData.diffNdd)}</td>
                                    <td className={evolutionData.diffIw >= 0 ? 'diff-pos' : 'diff-neg'}>{evolutionData.diffIw > 0 ? '+' : ''}{fmtMilhar(evolutionData.diffIw)}</td>
                                    <td className={evolutionData.diffTotal >= 0 ? 'diff-pos' : 'diff-neg'}>{evolutionData.diffTotal > 0 ? '+' : ''}{fmtMilhar(evolutionData.diffTotal)}</td>
                                </tr>
                                <tr style={{borderTop: '2px solid #546E7A'}}>
                                    <td className="row-header">% s/ mês anterior</td>
                                    <td className={evolutionData.pctNdd >= 0 ? 'diff-pos' : 'diff-neg'}>{evolutionData.pctNdd > 0 ? '+' : ''}{evolutionData.pctNdd.toFixed(1)}%</td>
                                    <td className={evolutionData.pctIw >= 0 ? 'diff-pos' : 'diff-neg'}>{evolutionData.pctIw > 0 ? '+' : ''}{evolutionData.pctIw.toFixed(1)}%</td>
                                    <td className={evolutionData.pctTotal >= 0 ? 'diff-pos' : 'diff-neg'}>{evolutionData.pctTotal > 0 ? '+' : ''}{evolutionData.pctTotal.toFixed(1)}%</td>
                                </tr>
                            </tbody>
                        </table>
                        <button className="btn-close-about" style={{marginTop: 25}} onClick={() => setShowEvolution(false)}>Fechar Tabela</button>
                    </div>
                </div>
            )}

            {/* --- MODAL DA TABELA DE DETALHES DE EMPRESAS --- */}
            {activeDetailFilter && (
                <div className="about-overlay" onClick={() => setActiveDetailFilter(null)}>
                    <div className="about-box" style={{width: '950px', maxWidth: '95%', maxHeight: '80vh', display: 'flex', flexDirection: 'column'}} onClick={e => e.stopPropagation()}>
                        
                        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15}}>
                            <h2 className="about-title">{filterNames[activeDetailFilter]}</h2>
                            <div style={{display: 'flex', alignItems: 'center', gap: '15px'}}>
                                <span style={{color: '#00E5FF', fontWeight: 'bold'}}>{fmtMilhar(detailsList.length)} empresas</span>
                                
                                {/* BOTÃO DE EXPORTAÇÃO ANIMADO E INTELIGENTE */}
                                <button 
                                    onClick={handleExportExcel}
                                    // ---> NOVA MÁGICA NO CLASSNAME <---
                                    // Adicionamos 'forced-hover' se isDialogOpening for true
                                    className={`btn-export ${exportStatus === 'success' ? 'is-success' : ''} ${isDialogOpening ? 'forced-hover' : ''}`}
                                    title="Salvar tabela como arquivo Excel"
                                    // Desativa o botão enquanto estiver ocupado para evitar duplos cliques
                                    disabled={isDialogOpening || exportStatus === 'success'}
                                >
                                    <div className="btn-export-inner">
                                        {exportStatus === 'success' ? (
                                            <Check size={16} strokeWidth={3} />
                                        ) : (
                                            <Download size={16} className="icon-download" />
                                        )}
                                        <span className="btn-export-text">
                                            {/* Transição suave do texto controlada pelo CSS */}
                                            {exportStatus === 'success' ? 'SUCESSO' : 'EXPORTAR'}
                                        </span>
                                    </div>
                                </button>
                            </div>
                        </div>
                        
                        {isLoadingSummaries ? (
                            <div style={{padding: 40, color: '#00E5FF'}}>Processando dados em segundo plano...</div>
                        ) : (
                            <div style={{overflowY: 'auto', flex: 1, border: '1px solid #455A64', borderRadius: 4}}>
                                <table className="evolution-table" style={{marginTop: 0}}>
                                    
                                    {/* CABEÇALHO ORDENÁVEL */}
                                    <thead style={{position: 'sticky', top: 0, zIndex: 5, userSelect: 'none'}}>
                                        <tr>
                                            <th onClick={() => handleModalSort('empresa')} style={{cursor: 'pointer', textAlign: 'left'}}>
                                                Empresa {modalSortKey === 'empresa' ? (modalSortDesc ? '▼' : '▲') : ''}
                                            </th>
                                            <th onClick={() => handleModalSort('qtde')} style={{cursor: 'pointer', width: '13%'}}>
                                                Qtde ({filterNames[activeDetailFilter]}) {modalSortKey === 'qtde' ? (modalSortDesc ? '▼' : '▲') : ''}
                                            </th>
                                            <th onClick={() => handleModalSort('mif')} style={{cursor: 'pointer', width: '12%'}}>
                                                Parque Total {modalSortKey === 'mif' ? (modalSortDesc ? '▼' : '▲') : ''}
                                            </th>
                                            <th onClick={() => handleModalSort('registered')} style={{cursor: 'pointer', width: '15%'}}>
                                                Monitoradas {modalSortKey === 'registered' ? (modalSortDesc ? '▼' : '▲') : ''}
                                            </th>
                                            <th onClick={() => handleModalSort('not_registered')} style={{cursor: 'pointer', width: '15%'}}>
                                                Não Monitoradas {modalSortKey === 'not_registered' ? (modalSortDesc ? '▼' : '▲') : ''}
                                            </th>
                                            <th onClick={() => handleModalSort('plataformas')} style={{cursor: 'pointer', width: '18%'}}>
                                                Plataformas Ativas {modalSortKey === 'plataformas' ? (modalSortDesc ? '▼' : '▲') : ''}
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {detailsList.map((c, i) => {
                                            // Cálculos de porcentagem em relação ao Parque Total (MIF)
                                            const pctMonitorada = c.mif > 0 ? Math.round((c.registered / c.mif) * 100) : 0;
                                            const pctNaoMonitorada = c.mif > 0 ? Math.round((c.not_registered / c.mif) * 100) : 0;

                                            return (
                                                <tr key={i}>
                                                    <td style={{textAlign: 'left', fontWeight: 'bold'}}>{c.empresa}</td>
                                                    <td style={{color: '#FFD740', fontWeight: 'bold', fontSize: 16}}>{fmtMilhar(c[activeDetailFilter] as number)}</td>
                                                    <td style={{color: '#B0BEC5'}}>{fmtMilhar(c.mif)}</td>
                                                    
                                                    {/* COLUNA MONITORADAS COM PORCENTAGEM */}
                                                    <td style={{color: '#00E676', fontWeight: 'bold'}}>
                                                        {fmtMilhar(c.registered)} <span style={{fontSize: 10, opacity: 0.7, fontWeight: 'normal'}}>({pctMonitorada}%)</span>
                                                    </td>
                                                    
                                                    {/* COLUNA NÃO MONITORADAS COM PORCENTAGEM */}
                                                    <td style={{color: '#EF5350', fontWeight: 'bold'}}>
                                                        {fmtMilhar(c.not_registered)} <span style={{fontSize: 10, opacity: 0.7, fontWeight: 'normal'}}>({pctNaoMonitorada}%)</span>
                                                    </td>
                                                    
                                                    <td>
                                                        <div style={{display: 'flex', gap: 5, justifyContent: 'center'}}>
                                                            {c.ndd > 0 && <span className="source-tag src-ndd" title={`${c.ndd} eqp NDD`}>NDD</span>}
                                                            {c.iw > 0 && <span className="source-tag src-iw" title={`${c.iw} eqp iW`}>iW</span>}
                                                            {(c.ndd === 0 && c.iw === 0) && <span style={{color: '#EF5350', fontSize: 10, fontWeight: 'bold'}}>NENHUMA</span>}
                                                        </div>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                        <button className="btn-close-about" style={{marginTop: 20, alignSelf: 'center'}} onClick={() => setActiveDetailFilter(null)}>Fechar Tabela</button>
                    </div>
                </div>
            )}

            {/* --- HEADER KPI DE METAS --- */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#37474F', padding: '15px 25px', borderBottom: '1px solid #546E7A', boxShadow: '0 4px 6px rgba(0,0,0,0.3)', zIndex: 10, flexShrink: 0 }}>
                <div style={{display: 'flex', gap: '15px'}}>
                    <div style={{display: 'flex', flexDirection: 'column', background: 'rgba(0,0,0,0.2)', padding: '10px 15px', borderRadius: '6px', border: '1px solid #455A64'}}>
                        <span style={{fontSize: 10, color: '#B0BEC5', textTransform: 'uppercase', fontWeight: 'bold'}}>Total Possível Monitoramento</span>
                        <span style={{fontSize: 18, color: '#fff', fontWeight: 'bold'}}>{fmtMilhar(totalBaseMeta)}</span>
                    </div>

                    <div 
                        className="card-clickable"
                        onClick={() => { setEvolutionOffset(0); if(evolutionData) setShowEvolution(true); }}
                        style={{display: 'flex', flexDirection: 'column', background: 'rgba(0,0,0,0.2)', padding: '10px 15px', borderRadius: '6px', border: '1px solid #455A64', cursor: evolutionData ? 'pointer' : 'default', position: 'relative'}}
                        title={evolutionData ? "Clique para ver a evolução mês a mês" : "Dados insuficientes para evolução"}
                    >
                        <span style={{fontSize: 10, color: '#B0BEC5', textTransform: 'uppercase', fontWeight: 'bold'}}>
                            Monitorados (iW+NDD) {evolutionData && <span style={{fontSize: 12, marginLeft: 4}}></span>}
                        </span>
                        <span style={{fontSize: 18, color: '#00E676', fontWeight: 'bold'}}>{fmtMilhar(monitorados)}</span>
                    </div>

                    <div style={{display: 'flex', flexDirection: 'column', background: 'rgba(0,0,0,0.2)', padding: '10px 15px', borderRadius: '6px', border: '1px solid #455A64'}}>
                        <span style={{fontSize: 10, color: '#B0BEC5', textTransform: 'uppercase', fontWeight: 'bold'}}>Falta Monitorar</span>
                        <span style={{fontSize: 18, color: '#EF5350', fontWeight: 'bold'}}>{fmtMilhar(faltaMonitorar)}</span>
                    </div>
                </div>

                <div style={{display: 'flex', alignItems: 'center', gap: '20px'}}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: isTargetMet ? 'rgba(0, 230, 118, 0.1)' : 'rgba(239, 83, 80, 0.1)', border: `2px solid ${isTargetMet ? '#00E676' : '#EF5350'}`, padding: '10px 20px', borderRadius: '8px', minWidth: '130px' }}>
                        <span style={{fontSize: 10, color: isTargetMet ? '#00E676' : '#EF5350', textTransform: 'uppercase', fontWeight: 'bold', marginBottom: 2}}>Percentual Monitorado</span>
                        <span style={{fontSize: 26, color: isTargetMet ? '#00E676' : '#EF5350', fontWeight: 'bold'}}>{resultPct.toFixed(2).replace('.', ',')}%</span>
                    </div>
                    <div style={{color: '#546E7A', fontSize: 20}}>➞</div>
                    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
                        <span style={{fontSize: 10, color: '#00E5FF', textTransform: 'uppercase', fontWeight: 'bold', marginBottom: 5}}>Meta Alvo (%)</span>
                        <div style={{display: 'flex', alignItems: 'baseline'}}>
                            <input type="number" step="0.1" value={targetStr} onChange={(e) => setTargetStr(e.target.value)} style={{ background: 'transparent', border: 'none', borderBottom: '2px solid #00E5FF', color: '#fff', fontSize: 26, fontWeight: 'bold', width: '80px', textAlign: 'center', outline: 'none' }} />
                        </div>
                    </div>
                    <div style={{width: '1px', height: '40px', background: '#546E7A', margin: '0 5px'}}></div>
                    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: '120px'}}>
                        <span style={{fontSize: 10, color: '#B0BEC5', textTransform: 'uppercase', fontWeight: 'bold', marginBottom: 5}}>Qtde Equiptos a Mais</span>
                        {qtdeAMais > 0 ? (
                            <span style={{fontSize: 26, color: '#FFD740', fontWeight: 'bold'}}>{fmtMilhar(qtdeAMais)}</span>
                        ) : (
                            <span style={{fontSize: 14, color: '#00E676', fontWeight: 'bold', marginTop: 8}}>META ATINGIDA ✓</span>
                        )}
                    </div>
                </div>
            </div>

            {/* --- DIAGRAMA DE ÁRVORE --- */}
            <div className="monitoring-container" style={{flex: 1, position: 'relative'}}>
                <div className="col-level" style={{flex: 0.8}}><ProCard id="mif" title="Parque Total (MIF)" value={data.mif} status="main" hasNext={true} /></div>
                <div className="col-level">
                    <div className="card-group grouped"><ProCard id="compatible" title="Compatíveis" value={data.compatible} total={data.mif} status="good" hasNext={true} /></div>
                    <div className="card-group grouped"><ProCard id="not_compatible" title="Incompatíveis" value={data.not_compatible} total={data.mif} status="bad" /></div>
                </div>
                <div className="col-level">
                    <div className="card-group grouped" style={{flexGrow: 1.5}}><ProCard id="registered" title="Monitorados" value={data.registered} total={data.compatible} status="good" hasNext={true} /></div>
                    <div className="card-group grouped" style={{flexGrow: 1}}><ProCard id="not_registered" title="Sem Monitoramento" value={data.not_registered} total={data.compatible} status="warn" hasNext={true} /></div>
                    <div className="card-group" style={{flexGrow: 0.5, visibility: 'hidden'}}></div>
                </div>
                <div className="col-level">
                    <div className="card-group grouped" style={{flexGrow: 1.5}}>
                        <ProCard id="ndd" title="NDD Print" value={data.ndd} total={data.registered} status="neutral" />
                        <ProCard id="iw" title="iW Remote" value={data.iw} total={data.registered} status="neutral" />
                    </div>
                    <div className="card-group grouped" style={{flexGrow: 1}}>
                        <div style={{display:'flex', flexDirection:'column', gap: 5, padding:'8px', background:'rgba(0,0,0,0.2)', borderRadius:4, border:'1px solid #546E7A', marginBottom: 5}}>
                            <div style={{fontSize:9, color:'#B0BEC5', fontWeight:'bold', marginBottom:2, textAlign:'center'}}>OPORTUNIDADES (POSSÍVEL)</div>
                            <div style={{display:'flex', gap:5}}>
                                <div style={{flex:1}}><ProCard id="possible_canon" title="Canon" value={data.possible_canon} status="good" /></div>
                                <div style={{flex:1}}><ProCard id="possible_inter" title="Inter" value={data.possible_inter} status="warn" /></div>
                            </div>
                        </div>
                        {/* --- NOVO CARD: NÃO POSSÍVEL DIVIDIDO --- */}
                <div 
                    className="card-clickable expand" 
                    onClick={() => setActiveDetailFilter('not_possible')} 
                    style={{display:'flex', flexDirection:'column', gap: 8, padding:'10px', background:'rgba(0,0,0,0.2)', borderRadius:4, borderLeft:'4px solid #EF5350', borderTop:'1px solid #546E7A', borderRight:'1px solid #546E7A', borderBottom:'1px solid #546E7A'}} 
                    title="Clique para ver as empresas com equipamentos Não Possíveis"
                >
                    <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', borderBottom: '1px solid #37474F', paddingBottom: 4}}>
                        <span style={{fontSize:10, color:'#B0BEC5', fontWeight:'bold'}}>NÃO POSSÍVEL</span>
                        <span style={{fontSize:16, color:'#fff', fontWeight:'bold'}}>
                            {fmtMilhar(data.not_possible)} <span style={{fontSize:10, color:'#B0BEC5', fontWeight:'normal'}}>eqp</span>
                        </span>
                    </div>
                    
                    <div style={{display:'flex', justifyContent:'space-between', gap: 10}}>
                        <div style={{flex:1, borderLeft:'2px solid #EF5350', paddingLeft: 6}}>
                            <div style={{fontSize:9, color:'#B0BEC5', fontWeight:'bold'}}>INCOMPATÍVEIS</div>
                            <div style={{fontSize:13, color:'#fff', fontWeight:'bold'}}>{fmtMilhar(data.not_compatible)}</div>
                        </div>
                        <div style={{flex:1, borderLeft:'2px solid #FFD740', paddingLeft: 6}}>
                            <div style={{fontSize:9, color:'#B0BEC5', fontWeight:'bold'}}>COM RESTRIÇÃO</div>
                            <div style={{fontSize:13, color:'#fff', fontWeight:'bold'}}>{fmtMilhar(data.not_possible - data.not_compatible)}</div>
                        </div>
                    </div>
                </div>
                {/* ---------------------------------------- */}
                    </div>
                    <div className="card-group" style={{flexGrow: 0.5, visibility: 'hidden'}}></div>
                </div>
                <div style={{position:'absolute', bottom: 10, right: 20, fontSize: 10, color: '#546E7A'}}>Ref: {formatDate(data.last_date)}</div>
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
const DefaultTooltip = ({ active, payload, label, view, selectedYear }: any) => { 
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

const RenderVerticalLineLabel = (props: any) => {
    const { viewBox, weeklySource, nddDate, iwDate } = props;
    const x = viewBox.x; const y = viewBox.y + 20;

    if (weeklySource === "Consolidado") {
        return (
            <g>
                <text x={x + 8} y={y} fill="#B0BEC5" fontSize={10} fontWeight="bold">Atualização:</text>
                <text x={x + 8} y={y + 14} fill="#B0BEC5" fontSize={10}>NDD: {nddDate}</text>
                <text x={x + 8} y={y + 28} fill="#B0BEC5" fontSize={10}>iW: {iwDate}</text>
            </g>
        );
    }
    return <text x={x + 8} y={y} fill="#B0BEC5" fontSize={10} fontWeight="bold">Atualização: {weeklySource === "NDD" ? nddDate : iwDate}</text>;
};

const RenderWeeklyLabel = (props: any) => {
    const { x, y, value, index, sundays, lineKey, color, currentDay, isCurrentOngoingMonth, totalDiasMes, allPoints } = props;
    const dia = index + 1;

    if (value == null) return null;

    // NOVO: Motor Inteligente Anti-Encavalamento
    let pushDown = false;
    if (allPoints && allPoints[index]) {
        const currentPoint = allPoints[index];
        let otherValue = null;

        // Descobre qual é o valor da "outra" linha para comparar
        if (lineKey === 'real_prev') {
            otherValue = isCurrentOngoingMonth ? currentPoint.est_curr : currentPoint.real_curr;
        } else {
            otherValue = currentPoint.real_prev;
        }

        if (otherValue != null && value > 0) {
            // Se a diferença entre as linhas for menor que 8%, nós separamos os rótulos
            const diffPct = Math.abs(value - otherValue) / Math.max(value, otherValue);
            if (diffPct < 0.08) {
                // O menor valor é empurrado para baixo da linha. 
                // Em caso de empate exato, o mês anterior vai para baixo.
                if (value < otherValue) {
                    pushDown = true;
                } else if (value === otherValue && lineKey === 'real_prev') {
                    pushDown = true;
                }
            }
        }
    }

    // A CAIXINHA DE PRODUÇÃO FINAL NO ÚLTIMO DIA DO MÊS
    if (dia === totalDiasMes) {
        let drawBox = false;
        
        if (lineKey === 'real_prev') drawBox = true;
        if (lineKey === 'real_curr' && !isCurrentOngoingMonth) drawBox = true;
        if (lineKey === 'est_curr' && isCurrentOngoingMonth) drawBox = true;

        if (drawBox) {
            // Ajusta a posição Y dependendo se a colisão mandou empurrar para baixo
            const boxY = pushDown ? y + 12 : y - 32;
            const textY = pushDown ? y + 26 : y - 18;

            return (
                <g style={{ filter: 'drop-shadow(2px 2px 3px rgba(0,0,0,0.5))' }}>
                    <rect x={x - 35} y={boxY} width={70} height={20} fill="#263238" stroke={color} strokeWidth={1.5} rx={4} ry={4} />
                    <text x={x} y={textY} fill={color} textAnchor="middle" fontSize={11} fontWeight="bold">
                        {fmtMilhar(value)}
                    </text>
                </g>
            );
        }
    }

    // Rótulos normais dos domingos
    if (!sundays || !sundays.includes(dia)) return null;
    if (lineKey === 'est_curr' && dia <= currentDay) return null;

    // Se houver colisão no domingo, empurra o texto para baixo da bolinha
    const textY = pushDown ? y + 20 : y - 12;

    return (
        <text x={x} y={textY} fill={color} textAnchor="middle" fontSize={11} fontWeight="bold" style={{ textShadow: '1px 1px 3px rgba(0,0,0,0.8), -1px -1px 3px rgba(0,0,0,0.8)' }}>
            {(Number(value) / 1000000).toFixed(1)}M
        </text>
    );
};

const RenderCustomDot = (props: any) => {
    const { cx, cy, stroke, index, sundays } = props;
    const dia = index + 1;
    if (!sundays || !sundays.includes(dia)) return null;
    return <circle cx={cx} cy={cy} r={4} fill={stroke} stroke="#263238" strokeWidth={2} />;
};

const ComparisonTooltip = ({ active, payload, label, selectedYear, lastUpdateDate }: any) => { if (active && payload && payload.length >= 2) { const prevData = payload.find((p: any) => p.dataKey === "prev_total"); const currData = payload.find((p: any) => p.dataKey === "curr_total"); if (!prevData || !currData) return null; const d = payload[0].payload; const prevVal = prevData.value; const currVal = currData.value; let dbDay = 0; let dbMonth = 0; let dbYear = 0; if (lastUpdateDate && lastUpdateDate !== "N/D") { const parts = lastUpdateDate.split('-'); if(parts.length === 3) { dbYear = parseInt(parts[0]); dbMonth = parseInt(parts[1]); dbDay = parseInt(parts[2]); } } const monthIndex = MESES.indexOf(label); const isCurrentMonthInDb = (selectedYear === dbYear) && (monthIndex === dbMonth); const isFutureMonth = (selectedYear === dbYear) && (monthIndex > dbMonth); let currentLabelText = `${currData.name}`; if (isCurrentMonthInDb && dbDay > 0) { currentLabelText = `Prod. até ${dbDay.toString().padStart(2, '0')}/${dbMonth.toString().padStart(2, '0')}`; } let diffDisplay = <></>; let estimateRow = <></>; if (prevVal > 0) { if (currVal === 0 && isFutureMonth) { diffDisplay = <span style={{color: '#90A4AE', fontStyle: 'italic', fontSize: 11}}>Aguardando dados...</span>; } else { let valToCompare = currVal; let isEstComparison = false; if (isCurrentMonthInDb && d.total_proj > currVal) { valToCompare = d.total_proj; isEstComparison = true; estimateRow = ( <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 11 }}> <span style={{color: '#FFD740', fontStyle: 'italic'}}>Produção estimada:</span> <span style={{color: '#fff', fontWeight: 'bold'}}>{fmtMilhar(d.total_proj)}</span> </div> ); } const diffPct = ((valToCompare - prevVal) / prevVal) * 100; let colorDiff = "#B0BEC5"; let diffText = "Estável"; if (diffPct > 0) { diffText = "Aumento"; colorDiff = "#00E676"; } else if (diffPct < 0) { diffText = "Diminuição"; colorDiff = "#EF5350"; } let diffSuffix = isEstComparison ? " (Est.)" : ""; diffDisplay = <span style={{color: colorDiff}}>{diffText}{diffSuffix} {Math.abs(diffPct).toFixed(2)}%</span>; } } else if (currVal > 0) { diffDisplay = <span style={{color: "#00E676"}}>Novo (100.00%)</span>; } return ( <div style={{ background: '#263238', border: '1px solid #546E7A', padding: '12px', borderRadius: '6px', minWidth: 180, zIndex: 100 }}> <p style={{ fontWeight: 'bold', color: 'white', marginBottom: 8, fontSize: 13, textAlign: 'center', borderBottom: '1px solid #455A64', paddingBottom: 4 }}>{label}</p> <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 12 }}> <span style={{color: '#90A4AE'}}>{prevData.name}:</span> <span style={{color: '#fff', fontWeight: 'bold'}}>{fmtMilhar(prevVal)}</span> </div> <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 12 }}> <span style={{color: '#00E5FF'}}>{currentLabelText}:</span> <span style={{color: '#fff', fontWeight: 'bold'}}>{fmtMilhar(currVal)}</span> </div> {estimateRow} <div style={{ borderTop: '1px solid #455A64', paddingTop: 6, textAlign: 'center', fontSize: 13, fontWeight: 'bold' }}>{diffDisplay}</div> </div> ); } return null; };

const WeeklyEvolutionTooltip = ({ active, payload, label, weeklyData, isCurrentOngoingMonth }: any) => { 
    if (active && payload && payload.length) { 
        const prevData = payload.find((p: any) => p.dataKey === "real_prev"); 
        const currDataReal = payload.find((p: any) => p.dataKey === "real_curr"); 
        const currDataEst = payload.find((p: any) => p.dataKey === "est_curr"); 

        const prevVal = prevData ? prevData.value : null; 
        let currVal = null; 
        let currLabel = ""; 
        let currColor = "";

        if (currDataReal && currDataReal.value != null) { 
            currVal = currDataReal.value; 
            currLabel = isCurrentOngoingMonth ? `Real ${weeklyData.mesAtualNome}` : `Acumulado Real ${weeklyData.mesAtualNome}`; 
            currColor = "#00E5FF";
        } else if (currDataEst && currDataEst.value != null) { 
            currVal = currDataEst.value; 
            currLabel = `Estimativa ${weeklyData.mesAtualNome}`; 
            currColor = "#FFD740";
        } 

        let diffDisplay = <></>; 
        if (prevVal > 0 && currVal !== null) { 
            const diffPct = ((currVal - prevVal) / prevVal) * 100; 
            let colorDiff = "#B0BEC5"; 
            let diffText = "Estável"; 
            if (diffPct > 0) { diffText = "Crescimento"; colorDiff = "#00E676"; } 
            else if (diffPct < 0) { diffText = "Redução"; colorDiff = "#EF5350"; } 
            
            diffDisplay = (
                <div style={{ borderTop: '1px solid #455A64', paddingTop: 6, marginTop: 6, textAlign: 'center', fontSize: 12, fontWeight: 'bold' }}>
                    <span style={{color: colorDiff}}>{diffText}: {diffPct > 0 ? '+' : ''}{diffPct.toFixed(2)}%</span>
                </div>
            );
        } 

        return ( 
            <div style={{ background: '#263238', border: '1px solid #546E7A', padding: '12px', borderRadius: '6px', minWidth: 190, zIndex: 100, boxShadow: '0px 4px 10px rgba(0,0,0,0.5)' }}> 
                <p style={{ fontWeight: 'bold', color: 'white', marginBottom: 8, fontSize: 13, textAlign: 'center', borderBottom: '1px solid #455A64', paddingBottom: 4 }}>Dia {label} do mês</p> 
                
                {currVal !== null && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 12 }}> 
                        <span style={{color: currColor}}>{currLabel}:</span> 
                        <span style={{color: '#fff', fontWeight: 'bold', marginLeft: 15}}>{fmtMilhar(currVal)}</span> 
                    </div>
                )}
                {prevVal !== null && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 12 }}> 
                        <span style={{color: '#90A4AE'}}>Acumulado Real {weeklyData.mesAntNome}:</span> 
                        <span style={{color: '#fff', fontWeight: 'bold', marginLeft: 15}}>{fmtMilhar(prevVal)}</span> 
                    </div>
                )}
                
                {diffDisplay} 
            </div> 
        ); 
    } 
    return null; 
};

// ==========================================================
// MOTOR DE NOTIFICAÇÃO CUSTOMIZADA (Carrossel Executivo V3)
// ==========================================================
export const CustomNotification = () => {
    const [data, setData] = useState({ title: '', body: '' });
    const [isExiting, setIsExiting] = useState(false);
    const [slideIndex, setSlideIndex] = useState(0);
    
    // Novos estados de controle de tempo e mouse
    const [isHovered, setIsHovered] = useState(false);
    const [, setTick] = useState(0);

    let payload: any = null;
    try { payload = JSON.parse(data.body); } catch(e) {}
    
    const isSlideshow = data.title === 'slideshow';

    useEffect(() => {
        let unlisten: any;
        const setup = async () => {
            unlisten = await listen("render-notification", (event: any) => {
                setData(event.payload);
                setIsExiting(false);
                setSlideIndex(0);
                setTick(0);
                setIsHovered(false);
                // NOTA: O setTimeout original sumiu daqui! O Motor de Ticks abaixo assumiu o controle absoluto.
            });
        };
        setup();
        return () => { if (unlisten) unlisten(); };
    }, []);

    // ---> O NOVO MOTOR DE TEMPO UNIVERSAL (Pausável) <---
    useEffect(() => {
        if (!isExiting && !isHovered) {
            const interval = setInterval(() => {
                setTick(prev => {
                    const next = prev + 1; // 1 pulso = 100ms
                    
                    if (isSlideshow) {
                        // A CADA 8 SEGUNDOS (80 pulsos) TROCA O SLIDE
                        if (next > 0 && next % 80 === 0) setSlideIndex(i => (i + 1) % 4);
                        
                        // TEMPO TOTAL: 4 Slides * 8s = 32 Segundos (320 pulsos)
                        if (next >= 320) {
                            setIsExiting(true);
                            setTimeout(() => invoke('hide_custom_notification'), 600);
                        }
                    } else {
                        // NOTIFICAÇÕES COMUNS: 7 Segundos (70 pulsos)
                        if (next >= 70) {
                            setIsExiting(true);
                            setTimeout(() => invoke('hide_custom_notification'), 600);
                        }
                    }
                    return next;
                });
            }, 100);
            return () => clearInterval(interval);
        }
    }, [isSlideshow, isExiting, isHovered]);

    const handleNotificationClick = () => {
        setIsExiting(true);
        let targetTab = 'production_current';
        
        if (isSlideshow) {
            if (slideIndex === 0 || slideIndex === 1) targetTab = 'production_current';
            else if (slideIndex === 2) targetTab = 'communication';
            else if (slideIndex === 3) targetTab = 'monitoring';
        } else if (payload && payload.tab) {
            targetTab = payload.tab;
        }

        invoke('open_main_window_at', { tab: targetTab });
        setTimeout(() => invoke('hide_custom_notification'), 400); 
    };

    // ---> NOVA LÓGICA DE NAVEGAÇÃO POR SCROLL <---
    const handleWheel = (e: React.WheelEvent) => {
        if (!isSlideshow) return;
        
        let nextIndex = slideIndex;
        // Scroll para baixo (Avança)
        if (e.deltaY > 0) {
            nextIndex = (slideIndex + 1) % 4;
        } 
        // Scroll para cima (Volta)
        else if (e.deltaY < 0) {
            nextIndex = (slideIndex - 1 + 4) % 4; // "+4" evita números negativos no Javascript
        }
        
        if (nextIndex !== slideIndex) {
            setSlideIndex(nextIndex);
            // Sincroniza o Relógio do Tempo! (Cada slide tem 80 pulsos de duração)
            setTick(nextIndex * 80);
        }
    };

    const slides = [
        { title: 'BASE DE DADOS', Icon: Database, color: '#00E5FF' },
        { title: 'PREVISÃO DE PRODUÇÃO', Icon: TrendingUp, color: '#B0BEC5' },
        { title: 'SAÚDE DE COMUNICAÇÃO', Icon: Activity, color: '#00E676' },
        { title: 'META DE MONITOR...', Icon: Target, color: '#FFD740' }
    ];

    const currentSlide = isSlideshow ? slides[slideIndex] : { title: data.title, Icon: Bell, color: '#00E5FF' };
    const borderColor = currentSlide.color;
    const CurrentIcon = currentSlide.Icon; // Extraímos o Ícone da vez

    return (
        <div style={{
            width: '100%', height: '100%', overflow: 'hidden', padding: '10px', boxSizing: 'border-box',
            display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', background: 'transparent'
        }}>
            <style>{`
                @keyframes slideIn { from { transform: translateX(120%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
                @keyframes slideOut { from { transform: translateX(0); opacity: 1; } to { transform: translateX(120%); opacity: 0; } }
                @keyframes shrink { from { width: 100%; } to { width: 0%; } }
                @keyframes fadeSlideUp { 
                    0% { opacity: 0; transform: translateY(10px); } 
                    100% { opacity: 1; transform: translateY(0); } 
                }
                .clickable-toast:hover { transform: scale(1.02); filter: brightness(1.1); }
                .slide-content { animation: fadeSlideUp 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards; }
            `}</style>
            
            <div 
                className="clickable-toast" 
                onClick={handleNotificationClick} 
                onMouseEnter={() => setIsHovered(true)}   
                onMouseLeave={() => setIsHovered(false)}  
                onWheel={handleWheel}                     // <--- MÁGICA DO SCROLL AQUI
                style={{
                    width: '400px', height: '230px', background: 'rgba(20, 25, 30, 0.95)', cursor: 'pointer', transition: 'all 0.3s ease',
                    border: `1px solid ${borderColor}`, borderRadius: '8px', boxShadow: `0 8px 24px rgba(0,0,0,0.6), inset 0 0 20px ${borderColor}15`,
                    display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden',
                    animation: isExiting ? 'slideOut 0.5s forwards cubic-bezier(0.175, 0.885, 0.32, 1.275)' : 'slideIn 0.5s forwards cubic-bezier(0.175, 0.885, 0.32, 1.275)'
                }}
            >
                <div style={{ padding: '10px 15px', borderBottom: '1px solid #37474F', display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(0,0,0,0.3)', transition: 'all 0.5s' }}>
                    <span style={{ display: 'flex', alignItems: 'center' }} key={`icon-${slideIndex}`}>
                        <CurrentIcon size={16} color={borderColor} />
                    </span>
                    <h4 key={`t-${slideIndex}`} className="slide-content" style={{ margin: 0, color: '#fff', fontSize: '13px', textTransform: 'uppercase', letterSpacing: '1px' }}>{currentSlide.title}</h4>
                    
                    {/* NOVO: Identificação de Fonte com Tags Profissionais */}
                    <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '9px', color: '#546E7A', fontWeight: 'bold', textTransform: 'uppercase' }}>
                        MONITORAMENTO
                        <span className="source-tag src-ndd" style={{ padding: '2px 4px', fontSize: '8px', margin: 0 }}>NDD</span>
                        <span style={{ color: '#546E7A', textTransform: 'lowercase' }}>e</span>
                        <span className="source-tag src-iw" style={{ padding: '2px 4px', fontSize: '8px', margin: 0 }}>iW</span>
                    </div>
                </div>
                
                {/* CORPO DO SLIDE (Com Padding Bottom de 25px para fugir das bolinhas) */}
                <div style={{ padding: '15px 15px 25px 15px', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                    
                    {isSlideshow && payload && (
                        <div key={`s-${slideIndex}`} className="slide-content" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                            
                            {/* SLIDE 0: DATAS APRIMORADO */}
                            {slideIndex === 0 && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', height: '100%' }}>
                                    <div style={{ flex: 1, background: 'rgba(0,0,0,0.3)', borderRadius: '6px', border: '1px solid #37474F', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px' }}>
                                        <span style={{ fontSize: '11px', color: '#B0BEC5', fontWeight: 'bold' }}>DATA ESPERADA:</span>
                                        <span style={{ fontSize: '18px', fontWeight: 'bold', color: '#00E676' }}>{payload.dates.targetBR}</span>
                                    </div>
                                    <div style={{ display: 'flex', gap: '10px', flex: 1.2 }}>
                                        <div style={{ flex: 1, background: 'rgba(0,0,0,0.3)', borderRadius: '6px', border: '1px solid #37474F', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                                            <span style={{ fontSize: '10px', color: '#B0BEC5', fontWeight: 'bold', marginBottom: '2px' }}>NDD PRINT</span>
                                            <span style={{ fontSize: '18px', fontWeight: 'bold', color: getDateStatusColor(payload.dates.rawNdd, payload.dates.target) }}>{payload.dates.ndd}</span>
                                        </div>
                                        <div style={{ flex: 1, background: 'rgba(0,0,0,0.3)', borderRadius: '6px', border: '1px solid #37474F', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                                            <span style={{ fontSize: '10px', color: '#B0BEC5', fontWeight: 'bold', marginBottom: '2px' }}>iW REMOTE</span>
                                            <span style={{ fontSize: '18px', fontWeight: 'bold', color: getDateStatusColor(payload.dates.rawIw, payload.dates.target) }}>{payload.dates.iw}</span>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* SLIDE 1: PRODUÇÃO */}
                            {slideIndex === 1 && (() => {
                                const growth = parseFloat(payload.production.growthPct);
                                const isPositive = growth > 0;
                                const isNegative = growth < 0;
                                const growthColor = isPositive ? '#00E676' : (isNegative ? '#EF5350' : '#B0BEC5');
                                const growthIcon = isPositive ? '▲' : (isNegative ? '▼' : '■');

                                return (
                                    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: '8px' }}>
                                        <div style={{ textAlign: 'center', fontSize: '11px', color: '#00E5FF', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '1px', borderBottom: '1px solid #37474F', paddingBottom: '4px' }}>
                                            MÊS REFERÊNCIA: {payload.production.monthName}
                                        </div>
                                        <div style={{ display: 'flex', gap: '10px', flex: 1 }}>
                                            <div style={{ flex: 1, borderRight: '1px solid #37474F', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
                                                {(() => {
                                                    // Descobre qual é a data mais recente entre NDD e iW para ser 100% preciso
                                                    const rawNdd = payload.dates.rawNdd !== "N/D" ? payload.dates.rawNdd : "0000-00-00";
                                                    const rawIw = payload.dates.rawIw !== "N/D" ? payload.dates.rawIw : "0000-00-00";
                                                    const dataMaisAtual = rawNdd > rawIw ? payload.dates.ndd : payload.dates.iw;
                                                    
                                                    return (
                                                        <span style={{ fontSize: '9px', color: '#B0BEC5', fontWeight: 'bold', textAlign: 'center', lineHeight: '1.2', marginBottom: '2px' }}>
                                                            PRODUÇÃO ATÉ <br/> <span style={{ color: '#fff' }}>{dataMaisAtual}</span>
                                                        </span>
                                                    );
                                                })()}
                                                <span style={{ fontSize: '28px', color: '#00E5FF', fontWeight: 'bold' }}>{payload.production.real}M</span>
                                            </div>
                                            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
                                                <span style={{ fontSize: '10px', color: '#B0BEC5', fontWeight: 'bold' }}>PROJEÇÃO</span>
                                                <span style={{ fontSize: '28px', color: '#FFD740', fontWeight: 'bold', lineHeight: '1' }}>{payload.production.est}M</span>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '4px', background: 'rgba(0,0,0,0.3)', padding: '2px 6px', borderRadius: '4px' }}>
                                                    <span style={{ color: growthColor, fontSize: '10px', fontWeight: 'bold' }}>{growthIcon} {Math.abs(growth)}%</span>
                                                    <span style={{ color: '#B0BEC5', fontSize: '9px' }}>vs Mês Ant.</span>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })()}

                            {/* SLIDE 2: COMUNICAÇÃO (COM GRÁFICO DONUT APRIMORADO E PORCENTAGENS) */}
                            {slideIndex === 2 && (() => {
                                const pct = parseFloat(payload.communication.onlinePct) || 0;
                                const isCommOk = pct >= payload.communication.target;
                                const total = payload.communication.onlineTotal + payload.communication.offlineTotal;
                                const offlinePct = total > 0 ? (payload.communication.offlineTotal / total) * 100 : 0;
                                const strokeColor = isCommOk ? '#00E676' : '#FFD740';
                                
                                const radius = 48;
                                const circumference = 2 * Math.PI * radius;
                                const offset = circumference - (pct / 100) * circumference;

                                const badgeText = isCommOk 
                                    ? `✓ META ATINGIDA${payload.communication.isPartial ? ' (PARCIAL)' : ''}` 
                                    : `⚠ ABAIXO DA META${payload.communication.isPartial ? ' (PARCIAL)' : ''}`;

                                return (
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '10px' }}>
                                        
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '25px' }}>
                                            <div style={{ position: 'relative', width: '110px', height: '110px' }}>
                                                <svg viewBox="0 0 120 120" width="100%" height="100%" style={{ filter: 'drop-shadow(0 6px 10px rgba(0,0,0,0.5))' }}>
                                                    <circle cx="60" cy="60" r={radius} fill="transparent" stroke="rgba(239, 83, 80, 0.2)" strokeWidth="14" />
                                                    <circle cx="60" cy="60" r={radius} fill="transparent" stroke={strokeColor} strokeWidth="14" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={offset} transform="rotate(-90 60 60)" style={{ transition: 'stroke-dashoffset 1s cubic-bezier(0.175, 0.885, 0.32, 1.275)' }} />
                                                    <text x="60" y="58" textAnchor="middle" fill="#fff" fontSize="24" fontWeight="bold">{pct.toFixed(1)}%</text>
                                                    <text x="60" y="74" textAnchor="middle" fill="#B0BEC5" fontSize="10" fontWeight="bold" opacity="0.8">ONLINE</text>
                                                </svg>
                                            </div>

                                            {/* Legenda Alargada para Caber a Porcentagem */}
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', width: '170px', fontSize: '13px' }}>
                                                    <span style={{ color: '#B0BEC5', display: 'flex', alignItems: 'center' }}>
                                                        <span style={{ color: strokeColor, marginRight: '6px', fontSize: '10px' }}>●</span>Online
                                                    </span>
                                                    <span style={{ color: '#fff', fontWeight: 'bold' }}>
                                                        {fmtMilhar(payload.communication.onlineTotal)} <span style={{fontSize: '10px', color: '#B0BEC5', fontWeight: 'normal'}}>({pct.toFixed(1)}%)</span>
                                                    </span>
                                                </div>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', width: '170px', fontSize: '13px' }}>
                                                    <span style={{ color: '#B0BEC5', display: 'flex', alignItems: 'center' }}>
                                                        <span style={{ color: '#EF5350', marginRight: '6px', fontSize: '10px' }}>●</span>Offline
                                                    </span>
                                                    <span style={{ color: '#fff', fontWeight: 'bold' }}>
                                                        {fmtMilhar(payload.communication.offlineTotal)} <span style={{fontSize: '10px', color: '#B0BEC5', fontWeight: 'normal'}}>({offlinePct.toFixed(1)}%)</span>
                                                    </span>
                                                </div>
                                                <div style={{ borderTop: '1px solid #455A64', marginTop: '2px', paddingTop: '8px', display: 'flex', justifyContent: 'space-between', width: '170px', fontSize: '10px' }}>
                                                    <span style={{ color: '#546E7A', fontWeight: 'bold', textTransform: 'uppercase' }}>Total Monitorados</span>
                                                    <span style={{ color: '#B0BEC5', fontWeight: 'bold', fontSize: '11px' }}>{fmtMilhar(total)}</span>
                                                </div>
                                            </div>
                                        </div>

                                        {/* Texto Limpo sem Caixa de Fundo para evitar sobreposição */}
                                        <div style={{ marginTop: '0px', textAlign: 'center' }}>
                                            <span style={{ fontSize: '12px', color: isCommOk ? '#00E676' : '#EF5350', fontWeight: 'bold', textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>
                                                {badgeText} <span style={{ opacity: 0.7, fontWeight: 'normal', marginLeft: '4px' }}>(Alvo: {payload.communication.target}%)</span>
                                            </span>
                                        </div>
                                    </div>
                                );
                            })()}

                            {/* SLIDE 3: MONITORAMENTO (MIF) - REDESENHADO COM DATA GRID */}
                            {slideIndex === 3 && (() => {
                                const isMifOk = payload.monitoring.currentPct >= payload.monitoring.targetPct;
                                return (
                                    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                                        
                                        {/* GRUPO SUPERIOR (Barras e Cards) */}
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                            
                                            {/* Header / Barra de Progresso */}
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                                                <div style={{ display: 'flex', flexDirection: 'column' }}>
                                                    <span style={{ fontSize: '10px', color: '#B0BEC5', fontWeight: 'bold' }}>MONITORAMENTO ATUAL</span>
                                                    <span style={{ fontSize: '24px', color: isMifOk ? '#00E676' : '#EF5350', fontWeight: 'bold', lineHeight: '1' }}>{payload.monitoring.currentPct.toFixed(1)}%</span>
                                                </div>
                                                <div style={{ display: 'flex', flexDirection: 'column', textAlign: 'right' }}>
                                                    <span style={{ fontSize: '10px', color: '#B0BEC5', fontWeight: 'bold' }}>META ALVO</span>
                                                    <span style={{ fontSize: '16px', color: '#fff', fontWeight: 'bold', lineHeight: '1' }}>{payload.monitoring.targetPct}%</span>
                                                </div>
                                            </div>
                                            <div style={{ width: '100%', height: '6px', background: '#263238', borderRadius: '3px', overflow: 'hidden', marginTop: '-2px' }}>
                                                <div style={{ width: `${payload.monitoring.currentPct}%`, height: '100%', background: isMifOk ? '#00E676' : '#EF5350', transition: 'width 1s ease' }}></div>
                                            </div>

                                            {/* Data Grid Profissional */}
                                            <div style={{ display: 'flex', gap: '10px' }}>
                                                <div style={{ flex: 1, background: 'rgba(0,0,0,0.3)', border: '1px solid #37474F', borderRadius: '6px', padding: '10px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                                                    <span style={{ fontSize: '9px', color: '#B0BEC5', fontWeight: 'bold', marginBottom: '4px' }}>MONITORÁVEIS</span>
                                                    <span style={{ fontSize: '18px', color: '#fff', fontWeight: 'bold' }}>{fmtMilhar(payload.monitoring.total)}</span>
                                                </div>
                                                
                                                <div style={{ flex: 1.4, background: 'rgba(0,0,0,0.3)', border: '1px solid #37474F', borderRadius: '6px', padding: '10px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                                                    <span style={{ fontSize: '9px', color: '#B0BEC5', fontWeight: 'bold', marginBottom: '4px' }}>MONITORADOS</span>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                                        <span style={{ fontSize: '20px', color: '#00E5FF', fontWeight: 'bold' }}>{fmtMilhar(payload.monitoring.registered)}</span>
                                                        
                                                        <div style={{ display: 'flex', flexDirection: 'column', borderLeft: '1px solid #455A64', paddingLeft: '8px', gap: '2px' }}>
                                                            <span style={{ fontSize: '9px', color: '#B0BEC5' }}>
                                                                NDD: <span style={{ color: '#fff', fontWeight: 'bold' }}>{fmtMilhar(payload.monitoring.ndd)}</span> 
                                                                <span style={{ opacity: 0.7 }}> ({payload.monitoring.registered > 0 ? ((payload.monitoring.ndd / payload.monitoring.registered) * 100).toFixed(1) : 0}%)</span>
                                                            </span>
                                                            <span style={{ fontSize: '9px', color: '#B0BEC5' }}>
                                                                iW: <span style={{ color: '#fff', fontWeight: 'bold' }}>{fmtMilhar(payload.monitoring.iw)}</span> 
                                                                <span style={{ opacity: 0.7 }}> ({payload.monitoring.registered > 0 ? ((payload.monitoring.iw / payload.monitoring.registered) * 100).toFixed(1) : 0}%)</span>
                                                            </span>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>

                                        {/* Footer de Resumo (Empurrado para o fundo com marginTop: 'auto') */}
                                        <div style={{ textAlign: 'center', fontSize: '11px', color: '#B0BEC5', marginTop: 'auto' }}>
                                            {isMifOk ? (
                                                <span style={{ color: '#00E676', fontWeight: 'bold' }}>✓ Parque plenamente auditado!</span>
                                            ) : (
                                                <span>Faltam <b style={{ color: '#FFD740' }}>{fmtMilhar(payload.monitoring.missing)}</b> equipamentos para a meta.</span>
                                            )}
                                        </div>
                                    </div>
                                );
                            })()}
                        </div>
                    )}
                </div>

                {/* INDICADORES DO CARROSSEL */}
                {isSlideshow && (
                    <div style={{ position: 'absolute', bottom: '15px', width: '100%', display: 'flex', justifyContent: 'center', gap: '6px' }}>
                        {[0,1,2,3].map(i => (
                            <div key={i} style={{ width: '6px', height: '6px', borderRadius: '50%', background: slideIndex === i ? borderColor : '#37474F', transition: 'all 0.3s' }} />
                        ))}
                    </div>
                )}
                
                {/* BARRA DE PROGRESSO DO TEMPO (Com Pausa) */}
                <div style={{ width: '100%', height: '4px', background: '#263238', position: 'absolute', bottom: 0 }}>
                    <div style={{ 
                        height: '100%', 
                        background: borderColor, 
                        transition: 'background 0.5s', 
                        animation: data.title ? `shrink ${isSlideshow ? '32s' : '7s'} linear forwards` : 'none',
                        animationPlayState: isHovered ? 'paused' : 'running' // <--- MÁGICA DO CSS AQUI
                    }} />
                </div>
            </div>
        </div>
    );
};
// ==========================================================

function App() {
  const [showAbout, setShowAbout] = useState(false);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [splashStatus, setSplashStatus] = useState("Iniciando...");
  const [splashProgress, setSplashProgress] = useState(10);
  const [splashError, setSplashError] = useState<string | null>(null);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState(""); 
  const [statusText, setStatusText] = useState("");
  const [data, setData] = useState<DashboardData | null>(null);
  const [companyCache, setCompanyCache] = useState<Record<string, DashboardData>>({}); 
  const [monitoringData, setMonitoringData] = useState<MonitoringData | null>(null);
  const [companySummaries, setCompanySummaries] = useState<MonitoringCompanySummary[]>([]);
  const [isLoadingSummaries, setIsLoadingSummaries] = useState(false);
  const [showGoalLine, setShowGoalLine] = useState(false);
  const [bgLoading, setBgLoading] = useState(false);
  const [areCompaniesReady, setAreCompaniesReady] = useState(false);
  const [toast, setToast] = useState<ToastMsg>({ message: '', type: 'info', visible: false });
  const [showDataWarning, setShowDataWarning] = useState(false);
  const [outdatedText, setOutdatedText] = useState("");
  const [syncDates, setSyncDates] = useState({ targetISO: '', nddISO: '', iwISO: '', targetBR: '', nddBR: '', iwBR: '' });
  const [companyList, setCompanyList] = useState<string[]>([]);
  const [currentView, setCurrentView] = useState<ViewType>('production_current');  
  const [syncProgressText, setSyncProgressText] = useState("");
  const [isUsingLocalDB, setIsUsingLocalDB] = useState(true);
  const [showOfflineWarning, setShowOfflineWarning] = useState(false);
  const [hasSyncFailed, setHasSyncFailed] = useState(false); // <--- ESTADO NOVO AQUI
  const [isFullySynced, setIsFullySynced] = useState(false);
  const hasDownloadedRef = useRef(false); // Memória para saber se algo foi baixado
  const [refreshTrigger, setRefreshTrigger] = useState(0); // Gatilho de recarga segura
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
  const itemsPerPage = 500;
  const [sortConfig, setSortConfig] = useState<SortConfig>({ key: 'total', direction: 'desc' });
  const [panelCache, setPanelCache] = useState<Record<string, any[]>>({});
  const fetchedKeys = useRef<Set<string>>(new Set());
  const dailyRawCache = useRef<Record<string, any[]>>({}); // Cache super rápido para o gráfico de linhas
  const [showNoUpdateModal, setShowNoUpdateModal] = useState(false);
  const [isMorningRoutine, setIsMorningRoutine] = useState(false);
  const [showDebugMenu, setShowDebugMenu] = useState(false); // <--- Controla a visibilidade do painel secreto

// AUTO-ATUALIZAÇÃO INTELIGENTE (Sem perder o cache da Visão Consolidada)
  useEffect(() => {
      if (refreshTrigger > 0) {
          // MÁGICA: Limpa a tela do Monitoramento para forçar ela a ler o novo cache fresco baixado!
          setMonitoringData(null);
          setCompanySummaries([]);

          const updateCacheSilently = async () => {
              try {
                  // MÁGICA 2: O robô baixou dados novos? Recalcula a visão "GERAL" no fundo silenciosamente
                  const geralData = await invoke<DashboardData>("fetch_dashboard_data", { year: year });
                  
                  let compData = null;
                  if (selectedCompany) {
                      // Se você estiver com uma empresa filtrada agora, atualiza ela também
                      compData = await invoke<DashboardData>("fetch_dashboard_data", { year: year, company: selectedCompany });
                      setData(compData);
                  } else {
                      setData(geralData);
                  }
                  
                  // CORREÇÃO: Atualiza os dados consolidados independentemente do ano selecionado.
                  setCompanyCache(prev => {
                      const updatedCache = { ...prev };
                      updatedCache["GERAL"] = geralData;
                      if (selectedCompany && compData) {
                          updatedCache[selectedCompany] = compData;
                      }
                      return updatedCache;
                  });

                  // ---> CORREÇÃO: Libera a avaliação de datas SÓ AQUI, com os dados novos já em memória!
                  setIsFullySynced(true);
              } catch (err) {
                  console.error(err);
                  setIsFullySynced(true); // Libera mesmo com erro para não travar
              }
          };
          updateCacheSilently();
      }
  }, [refreshTrigger]); // Apenas o trigger para não engavetar quando trocar de ano

  // ATUALIZADOR GLOBAL DE DATAS E AVISOS (O Cérebro do Tempo)
  useEffect(() => {
      if (!data) return;

      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const yyyy = yesterday.getFullYear();
      const mm = String(yesterday.getMonth() + 1).padStart(2, '0');
      const dd = String(yesterday.getDate()).padStart(2, '0');
      const targetDateStr = `${yyyy}-${mm}-${dd}`;

      setSyncDates({
          targetISO: targetDateStr,
          nddISO: data.last_update_ndd || "N/D",
          iwISO: data.last_update_iw || "N/D",
          targetBR: `${dd}/${mm}/${yyyy}`,
          nddBR: formatDate(data.last_update_ndd),
          iwBR: formatDate(data.last_update_iw)
      });

      // === NOVO CÁLCULO: SAÚDE DE COMUNICAÇÃO (ONLINE %) ===
      let commPercentage = "0.0";
      let totalConnGlobal = 0; // <--- NOVO
      let totalDiscGlobal = 0; // <--- NOVO
      
      if (data.communication && data.communication.length > 0) {
          const currentYear = new Date().getFullYear();
          const commThisYear = data.communication.filter(c => c.ano === currentYear && (c.connected + c.disconnected) > 0);
          
          if (commThisYear.length > 0) {
              const latestMonth = Math.max(...commThisYear.map(c => c.mes));
              const totalConn = commThisYear.filter(c => c.mes === latestMonth).reduce((acc, curr) => acc + curr.connected, 0);
              const totalDisc = commThisYear.filter(c => c.mes === latestMonth).reduce((acc, curr) => acc + curr.disconnected, 0);
              const totalEqp = totalConn + totalDisc;
              
              totalConnGlobal = totalConn; // <--- SALVA O TOTAL
              totalDiscGlobal = totalDisc; // <--- SALVA O TOTAL
              
              if (totalEqp > 0) {
                  commPercentage = ((totalConn / totalEqp) * 100).toFixed(1);
              }
          }
      }

      // === ATUALIZA O TOOLTIP DA BANDEJA ===
      let tooltipText = `RPA Monitoramento\n`;
      const isOutdated = data.last_update_ndd === "N/D" || data.last_update_ndd < targetDateStr || data.last_update_iw === "N/D" || data.last_update_iw < targetDateStr;
      
      if (isOutdated) {
          tooltipText += `❌ Desatualizado\n`;
      } else {
          tooltipText += `✅ Atualizado (D-1)\n`;
      }
      tooltipText += `Online: ${commPercentage}%`; // <-- Agora reflete os 91% corretamente!
      
      invoke('update_tray_tooltip', { tooltip: tooltipText }).catch(console.error);
      // ====================================================

      // O aviso de dados desatualizados na tela grande só é avaliado se a sincronização não falhou (para não confundir o usuário com dois avisos)
          if (isFullySynced && !hasSyncFailed) {
              let outdated = [];
              if (data.last_update_ndd !== "N/D" && data.last_update_ndd < targetDateStr) outdated.push("NDD Print");
              if (data.last_update_iw !== "N/D" && data.last_update_iw < targetDateStr) outdated.push("iW Remote");
              
              if (outdated.length > 0) {
                  setOutdatedText(outdated.join(" e o "));
                  
                  // MÁGICA: Só mostra o modal de alerta UMA VEZ POR DIA!
                  const todayStr = new Date().toDateString();
                  const lastWarning = localStorage.getItem('last_data_warning_date');
                  
                  if (lastWarning !== todayStr) {
                      setShowDataWarning(true);
                      localStorage.setItem('last_data_warning_date', todayStr);
                  }
              } else {
                  setShowDataWarning(false);
              }
          }

          // === ROTINA MATINAL CONCLUÍDA: AVALIAÇÃO INTELIGENTE ===
          // MÁGICA OFFLINE: Retirado da trava de erro! Agora roda SEMPRE que o processo de checagem (com sucesso ou falha) acabar.
          if (isFullySynced && isMorningRoutine) {
              setIsMorningRoutine(false); 
              
              const mesAtual = new Date().getMonth() + 1;
              const anoAtual = new Date().getFullYear();
              
              // ---> A MÁGICA DO NOME DO MÊS RESTAURADA AQUI <---
              const mesesNomes = ["", "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
              const nomeMesAtual = mesesNomes[mesAtual];
              
              // 1. DADOS DE PRODUÇÃO
              const prodMes = data.production.filter(prod => prod.ano === anoAtual && prod.mes === mesAtual).reduce((acc, curr) => acc + curr.pb + curr.cor, 0);
              const estPB = data.projection.ndd_pb + data.projection.iw_pb;
              const estCor = data.projection.ndd_cor + data.projection.iw_cor;
              const totalEst = estPB + estCor;
              
              // Descobre o mês anterior
              let prevMonth = mesAtual - 1;
              let prevYear = anoAtual;
              if (prevMonth < 1) { prevMonth = 12; prevYear -= 1; }
              
              // Soma a produção do mês anterior e calcula a diferença %
              const prodMesAnterior = data.production.filter(prod => prod.ano === prevYear && prod.mes === prevMonth).reduce((acc, curr) => acc + curr.pb + curr.cor, 0);
              let pctCrescimento = 0;
              if (prodMesAnterior > 0) {
                  pctCrescimento = ((totalEst - prodMesAnterior) / prodMesAnterior) * 100;
              }
              
              // 2. DADOS DE MONITORAMENTO (MIF)
              const monitorados = monitoringData?.registered || 0;
              const faltaMonitorar = (monitoringData?.possible_canon || 0) + (monitoringData?.possible_inter || 0);
              const totalBaseMeta = monitorados + faltaMonitorar;
              const targetPct = 82.0; // Meta do sistema
              const targetQtd = Math.ceil(totalBaseMeta * (targetPct / 100));
              const qtdeAMais = targetQtd > monitorados ? targetQtd - monitorados : 0;
              const currentMifPct = totalBaseMeta > 0 ? (monitorados / totalBaseMeta) * 100 : 0;

              // ENVIA O MALOTE ÚNICO DO CARROSSEL
              invoke('show_custom_notification', { 
                  title: 'slideshow', // Tag secreta para ativar o carrossel
                  body: JSON.stringify({
                      dates: { ndd: syncDates.nddBR, iw: syncDates.iwBR, target: syncDates.targetISO, targetBR: syncDates.targetBR, rawNdd: data.last_update_ndd, rawIw: data.last_update_iw },
                      production: { 
                          real: (prodMes / 1000000).toFixed(1), 
                          est: (totalEst / 1000000).toFixed(1),
                          monthName: nomeMesAtual, 
                          growthPct: pctCrescimento.toFixed(1) 
                      },
                      communication: { 
                          onlinePct: commPercentage, 
                          onlineTotal: totalConnGlobal, 
                          offlineTotal: totalDiscGlobal, 
                          target: 90.0,
                          isPartial: data.last_update_ndd !== "N/D" && new Date(data.last_update_ndd + "T00:00:00").getMonth() === new Date().getMonth() 
                      },
                      monitoring: { 
                          total: totalBaseMeta, 
                          registered: monitorados,      
                          ndd: monitoringData?.ndd || 0, 
                          iw: monitoringData?.iw || 0,   
                          currentPct: currentMifPct, 
                          missing: qtdeAMais, 
                          targetPct: targetPct 
                      }
                  })
              });

              // ---> NOVA MÁGICA DA BOLINHA AQUI <---
              // Só acende se o usuário NÃO estiver com o painel aberto/em foco na tela
              if (document.visibilityState === 'hidden' || !document.hasFocus()) {
                  invoke('set_alert_icon', { alert: true }).catch(console.error);
              }
          }
  }, [data, isFullySynced, hasSyncFailed, isMorningRoutine, monitoringData]);

  // Auto-limpador inteligente de mensagens do rodapé
  useEffect(() => {
      if (!statusText) return;
      const t = statusText.toLowerCase();
      // Se a mensagem contiver alguma dessas palavras de "Conclusão", ele apaga após 4s
      if (t.includes("atualizada") || t.includes("pronto") || t.includes("completo") || t.includes("restaurada") || t.includes("(cache)") || t.includes("offline")) {
          const timer = setTimeout(() => setStatusText(""), 4000);
          return () => clearTimeout(timer);
      }
  }, [statusText]);

  // Auto-limpador inteligente de mensagens da NUVEM (faz o 100% sumir)
  useEffect(() => {
      if (!syncProgressText) return;
      if (syncProgressText.includes("100% sincronizado")) {
          const timer = setTimeout(() => setSyncProgressText(""), 4000); // Some após 4 segundos
          return () => clearTimeout(timer);
      }
  }, [syncProgressText]);

  // ---> MOTOR DE ATUALIZAÇÃO INTELIGENTE (Manual, Matinal e Horário) <---
  const handleManualSync = async (triggerType: 'manual' | 'morning' | 'hourly' = 'manual') => {
      if (syncProgressText || bgLoading) return; 
      setSyncProgressText("Verificando servidor...");
      
      try {
          const hasUpdates = await invoke<boolean>("check_for_updates");
          
          if (!hasUpdates) {
              setSyncProgressText("");
              setHasSyncFailed(false);
              setIsFullySynced(true); 
              
              if (triggerType === 'morning') {
                  setIsMorningRoutine(true); // 08h30: Dispara o carrossel MESMO sem dados novos
              } else if (triggerType === 'manual') {
                  setShowNoUpdateModal(true); // Usuário clicou: Mostra aviso verde
              }
              // Se for 'hourly', morre silenciosamente, não perturba o usuário.
          } else {
              setIsFullySynced(false); 
              setHasSyncFailed(false);
              setShowDataWarning(false); 
              setSyncProgressText("Iniciando download da nuvem...");
              invoke('update_tray_tooltip', { tooltip: "Monitoramento RPA v3.0\nStatus: ⏳ Sincronizando..." });
              
              if (triggerType === 'morning' || triggerType === 'hourly') {
                  setIsMorningRoutine(true); // Fica na espera. Vai soltar os balões quando o download acabar.
              }
              await invoke("trigger_background_sync"); 
          }
      } catch (e) {
          console.error(e);
          setSyncProgressText("");
          setHasSyncFailed(true);
          
          if (triggerType === 'morning') {
              setIsMorningRoutine(true); // 08h30: Dispara o carrossel MESMO se a internet cair (Modo Offline)
          } else if (triggerType === 'manual') {
              setShowOfflineWarning(true);
          }
      }
  };
  
// MÁGICA: A FUNÇÃO FORMATADORA DO EIXO Y DEVE ESTAR AQUI DENTRO!
  const formatYAxis = (val: number) => {
      if (currentView === 'communication') {
          // Se estiver na comunicação (percentual), limita a 100% no visual
          const pct = Math.round(val * 100);
          return pct > 100 ? '100%' : `${pct}%`;
      }
      // Se for produção, mostra em milhões (ex: 2.5M)
      return `${(val / 1000000).toFixed(1)}M`;
  };
  
  // ---> LÓGICA DE "O QUE HÁ DE NOVO" <---
  const APP_VERSION = "3.0.2"; // Dispara a janela de novidades!
  const [showWhatsNew, setShowWhatsNew] = useState(false);

  useEffect(() => {
      // Só verifica depois que o splash screen terminar de carregar
      if (!isInitialLoad) {
          const lastSeenVersion = localStorage.getItem('last_seen_version');
          if (lastSeenVersion !== APP_VERSION) {
              setShowWhatsNew(true);
              localStorage.setItem('last_seen_version', APP_VERSION);
          }
      }
  }, [isInitialLoad]);
        useEffect(() => {
            if (currentView === 'communication') {
                setShowGoalLine(false);
                const timer = setTimeout(() => setShowGoalLine(true), 900); 
                return () => clearTimeout(timer);
            }
        }, [currentView]);

// --- PRÉ-CARREGAMENTO E LOGS APRIMORADOS ---
  useEffect(() => {
      if (!data || !data.production) return;

      // ---> MÁGICA: Impede o engavetamento! Só faz as consultas de fundo depois que a lista de empresas estiver 100% livre.
      if (!areCompaniesReady) return;

      const monthsToFetch = [...new Set(
          data.production
              .filter(p => p.ano === year && (p.pb + p.cor) > 0)
              .map(p => p.mes)
      )].sort((a, b) => b - a);

      if (monthsToFetch.length === 0) {
          setStatusText(`Pronto: ${year} | ${source}`);
          return;
      }

      let isCancelled = false;

      const prefetchAll = async () => {
              const isGeneralView = !selectedCompany;
              let fetchCount = 0;

              // ---> 1. PRIORIDADE MÁXIMA: DADOS DIÁRIOS PARA A JANELA DE PREVISÕES <---
              // Descobre o mês e ano alvo baseado na última leitura real do banco
              const today = new Date();
              let dbDate = today;
              if (data?.last_update_ndd && data.last_update_ndd !== "N/D") {
                  const parts = data.last_update_ndd.split('-');
                  if (parts.length === 3) {
                      dbDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
                  }
              }
              
              let topMonth = dbDate.getMonth() + 1;
              let topYear = dbDate.getFullYear();
              let prevTopMonth = topMonth - 1;
              let prevTopYear = topYear;
              if (prevTopMonth < 1) { prevTopMonth = 12; prevTopYear -= 1; }

              setStatusText(`Preparando motor de previsões...`);
              const sources = ["Consolidado", "NDD", "iW"];
              
              // Baixa os dados diários essenciais instantaneamente
              for (const src of sources) {
                  if (isCancelled) break;
                  const currKey = `${topYear}-${topMonth}-${src}-${selectedCompany || 'GERAL'}`;
                  const prevKey = `${prevTopYear}-${prevTopMonth}-${src}-${selectedCompany || 'GERAL'}`;
                  
                  const fetches = [];
                  if (!dailyRawCache.current[currKey]) {
                      const argsCurr: any = { year: topYear, month: topMonth, source: src };
                      if (!isGeneralView) argsCurr.company = selectedCompany;
                      fetches.push(invoke<any[]>("fetch_daily_production", argsCurr).then(res => dailyRawCache.current[currKey] = res));
                  }
                  if (!dailyRawCache.current[prevKey]) {
                      const argsPrev: any = { year: prevTopYear, month: prevTopMonth, source: src };
                      if (!isGeneralView) argsPrev.company = selectedCompany;
                      fetches.push(invoke<any[]>("fetch_daily_production", argsPrev).then(res => dailyRawCache.current[prevKey] = res));
                  }
                  try { await Promise.all(fetches); } catch(e) {}
              }

              // ---> 2. PRIORIDADE SECUNDÁRIA: SIDE PANEL (Apenas os 2 meses mais recentes) <---
              const panelCommand = isGeneralView ? "fetch_month_summary_cmd" : "fetch_month_details_cmd";
              const monthsForPanel = monthsToFetch.slice(0, 2); // Corta a lista para reter apenas os 2 primeiros!

              for (const month of monthsForPanel) {
                  if (isCancelled) break;

                  const cacheKey = `${year}-${selectedCompany || 'GERAL'}-${month}`;
                  if (fetchedKeys.current.has(cacheKey) || panelCache[cacheKey]) continue;

                  fetchedKeys.current.add(cacheKey);
                  try {
                      setStatusText(`Baixando painel lateral: ${MESES[month]}/${year}...`);
                      const args: any = { year, month };
                      if (!isGeneralView) args.company = selectedCompany;

                      const res = await invoke<any[]>(panelCommand, args);
                      if (isCancelled) break;

                      setPanelCache(prev => ({ ...prev, [cacheKey]: res }));
                      fetchCount++;
                      
                      // Dá um respiro super rápido para não travar a interface
                      await new Promise(r => setTimeout(r, 100));
                  } catch (err) {
                      fetchedKeys.current.delete(cacheKey);
                  }
              }

              // Quando terminar de baixar tudo, avisa que está pronto
              if (!isCancelled) {
                  setStatusText(`Pronto! Gráficos em cache.`);
                  setTimeout(() => { if (!isCancelled) setStatusText(`Visualizando: ${year} | ${source}`); }, 4000);
              }
          };

      prefetchAll();
      return () => { isCancelled = true; };
  }, [data, year, selectedCompany, source]); 
  
  // RECUPERADOR DO DIAGRAMA E DAS TABELAS (Desacoplado e Inteligente)
  useEffect(() => {
      if (isInitialLoad) return; // <--- TRAVA DE OURO: Espera o Rust ligar o banco de dados antes de perguntar!

      let isCancelled = false;
      let retryCount = 0; // Limite de tentativas para não travar no Modo Offline

      const tryFetchMIF = () => {
          if (isCancelled) return;

          // 1. Tenta buscar o diagrama principal (Cards)
          if (!monitoringData) {
              invoke<MonitoringData>("fetch_monitoring_data").then(res => {
                  if (!isCancelled) {
                      // Se vier zerado, tenta até 5 vezes. Se passar disso, aceita para liberar a tela.
                      if (res.mif === 0 && retryCount < 5 && !hasSyncFailed) {
                          retryCount++;
                          setTimeout(tryFetchMIF, 3000);
                      } else {
                          setMonitoringData(res);
                      }
                  }
              }).catch(() => {
                  if (!isCancelled) setTimeout(tryFetchMIF, 2500); 
              });
          }

          // 2. Tenta buscar a tabela de empresas (Modal)
          if (companySummaries.length === 0) {
              setIsLoadingSummaries(true);
              invoke<MonitoringCompanySummary[]>("fetch_monitoring_company_summary")
                  .then(summaries => {
                      if (!isCancelled) {
                          if (summaries.length === 0 && retryCount < 5 && !hasSyncFailed) {
                              setTimeout(tryFetchMIF, 3000);
                          } else {
                              setCompanySummaries(summaries);
                              setIsLoadingSummaries(false);
                          }
                      }
                  })
                  .catch(() => { 
                      if (!isCancelled) {
                          setIsLoadingSummaries(false);
                          setTimeout(tryFetchMIF, 2500);
                      }
                  });
          }
      };

      tryFetchMIF();
      
      return () => { isCancelled = true; setIsLoadingSummaries(false); };
  }, [isInitialLoad, currentView, monitoringData, companySummaries.length, hasSyncFailed]);

  // Atualiza as empresas quando o ano muda
  useEffect(() => { 
      if(!isInitialLoad && areCompaniesReady) { 
          setStatusText(`Verificando empresas ativas em ${year}...`);
          invoke<string[]>("fetch_companies", { year: year })
            .then(list => {
                setCompanyList(list);
                setStatusText(`Lista de empresas de ${year} atualizada.`);
            });
      } 
  }, [year, areCompaniesReady, isInitialLoad]);

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
    let unlisten: any; let unlistenMonitor: any; let unlistenLoading: any; let unlistenSync: any; let unlistenCompanies: any; let unlistenFailed: any; let unlistenChunk: any; let unlistenStartupFailed: any;
    let unlistenMorning: any; let unlistenTraySync: any; let unlistenNavigate: any; let unlistenHourly: any;

    const initEverything = async () => {
        // Trava imediata para evitar dupla inicialização
        if (didInit.current) return;
        didInit.current = true;

        // --- ESCUTAS DE RELÓGIO DO RUST ---
        unlistenMorning = await listen("time-to-morning-sync", () => {
            handleManualSync('morning'); 
        });
        
        unlistenHourly = await listen("time-to-hourly-sync", () => {
            handleManualSync('hourly'); 
        });

        // 1. OBRIGA O REACT A REGISTRAR OS OUVINTES PRIMEIRO (AGUARDA CADA UM)
        unlisten = await listen("splash-status", (event: any) => { 
            const msg = event.payload as string;
            setSplashStatus(msg); 
            setSplashProgress(prev => Math.min(prev + 10, 95)); 
            if (msg.includes("Nuvem") || msg.includes("Servidor")) setIsUsingLocalDB(false);
            else if (msg.includes("Banco Local")) setIsUsingLocalDB(true);
        });        
        unlistenMonitor = await listen("monitoring-status", (event: any) => { setStatusText(event.payload as string); });
        unlistenLoading = await listen("loading-status", (event: any) => { setStatusText(event.payload as string); });
        
        unlistenCompanies = await listen("companies-ready", () => {
            setAreCompaniesReady(true);
            invoke<string[]>("fetch_companies", { year: new Date().getFullYear() })
                .then((list) => {
                    setCompanyList(list);
                    setStatusText("Lista de empresas atualizada.");
                    setBgLoading(false); 
                    showToast("Filtro de empresas pronto para uso.", "success");
                }).catch(console.error);
        });

        unlistenSync = await listen("sync-status", (event: any) => { 
            const msg = event.payload as string;
            setSyncProgressText(msg); 
            if (msg.toLowerCase().includes("baixando")) hasDownloadedRef.current = true;
            if (msg.includes("100% sincronizado")) {
                setHasSyncFailed(false);
                if (hasDownloadedRef.current) {
                    // Tem dados novos! Dispara a busca (o isFullySynced será acionado lá dentro).
                    setRefreshTrigger(Date.now());
                    hasDownloadedRef.current = false;
                } else {
                    // Não baixou nada novo (estava apenas checando). Pode liberar a avaliação direto.
                    setIsFullySynced(true);
                }
            }
        });

        unlistenFailed = await listen("sync-failed", () => { 
            setHasSyncFailed(true); 
            setShowOfflineWarning(true); 
            setIsFullySynced(true);
        });
        
        unlistenStartupFailed = await listen("startup-sync-failed", () => { 
            setHasSyncFailed(true); 
            setShowOfflineWarning(true);
            setIsFullySynced(true);
        });
        unlistenChunk = await listen("sync-chunk-done", () => { setRefreshTrigger(Date.now()); });

        // --- ESCUTA O CLIQUE DO ALERTA E MUDA A ABA ---
        unlistenNavigate = await listen("navigate-to", (event: any) => {
            setCurrentView(event.payload as ViewType);
            setIsPanelOpen(false); 
            setShowWeeklyModal(false);
            setShowAbout(false);
        });
        
        // --- ESCUTA O CLIQUE DO MENU DA BANDEJA PARA ATUALIZAR ---
        unlistenTraySync = await listen("tray-force-sync", () => { 
            handleManualSync('manual'); 
        });

        // 2. SÓ ACORDA O RUST DEPOIS QUE O REACT ESTIVER 100% PRONTO PARA OUVIR
        try {
            const startTime = Date.now();
            const initialData = await invoke<DashboardData>("perform_initial_load");
            
            // Reduzimos o engarrafamento para 1500ms, pois o Rust agora coreografa as mensagens de status!
            const elapsed = Date.now() - startTime;
            if (elapsed < 1500) {
                await new Promise(r => setTimeout(r, 1500 - elapsed));
            }

            setSplashProgress(100); 
            setSplashStatus("Carregado."); 
            setData(initialData); 
            
            setCompanyCache({ "GERAL": initialData });
            
            invoke("finalize_startup").catch(console.error); 
            setTimeout(() => { setIsInitialLoad(false); }, 300);
            
            showToast(`Sistema iniciado e pronto para uso.`, 'success');

            invoke<MonitoringData>("fetch_monitoring_data")
                .then(res => { 
                    if (res.mif > 0) setMonitoringData(res); 
                })
                .catch(() => console.log("Diagrama na fila de espera..."));

        } catch (err) { 
            console.error("ERRO CRÍTICO:", err); 
            setSplashError("Não conectado. Você precisa estar na VPN para se conectar ao banco de dados."); 
        }
    };

    // Executa a sequência orquestrada
    initEverything();
        
    return () => { 
        if(unlisten) unlisten(); if(unlistenMonitor) unlistenMonitor(); 
        if(unlistenLoading) unlistenLoading(); if(unlistenSync) unlistenSync(); 
        if(unlistenCompanies) unlistenCompanies(); if(unlistenFailed) unlistenFailed(); 
        if(unlistenChunk) unlistenChunk(); if(unlistenStartupFailed) unlistenStartupFailed(); 
        if(unlistenMorning) unlistenMorning(); if(unlistenTraySync) unlistenTraySync(); 
        if(unlistenNavigate) unlistenNavigate(); if(unlistenHourly) unlistenHourly();
    };
  }, []);

    useEffect(() => { 
        if(!isInitialLoad && areCompaniesReady) { 
            invoke<string[]>("fetch_companies", { year: year }).then(setCompanyList); 
        } 
    }, [year, areCompaniesReady, isInitialLoad]);

  // --- FUNÇÃO AUXILIAR PARA TRATAR ERROS DE CONEXÃO ---
  const handleApiError = (err: any, retryCallback: () => void) => {
      console.error("API ERROR:", err);
      setLoadingMsg(""); // Limpa mensagem de loading
      setIsLoadingData(false); // Para o spinner global
      setPanelLoading(false); // Para o spinner do painel
      setRetryAction(() => retryCallback); // Guarda a função para tentar de novo
      setConnectionError(true); // Abre o modal
  };

const handleFetchData = async (empresa: string, targetYear: number) => {
      // MÁGICA: A chave usa apenas a Empresa, pois o pacote do banco já traz TODOS os anos juntos!
      const cacheKey = empresa || "GERAL";

      // 1. Se já tiver no cache da memória, mostra IMEDIATAMENTE (zero espera)
      if (companyCache[cacheKey]) { 
          setData(companyCache[cacheKey]); 
          setStatusText(`Filtro: ${empresa ? empresa : "Consolidado"} (Cache)`); 
          return; 
      }
      
      // 2. MÁGICA ANTI-FLICKER (Truque de UX)
      // Aguarda 300ms antes de mostrar a tela escura. Se o banco SQLite responder rápido, a tela não pisca!
      let isFetching = true;
      const loadingTimer = setTimeout(() => {
          if (isFetching) {
              setIsLoadingData(true); 
              setLoadingMsg(empresa ? "Preparando filtro..." : "Restaurando visão consolidada..."); 
              setStatusText(empresa ? "Filtrando..." : "Restaurando...");
          }
      }, 300);
      
      const unlisten = await listen("splash-status", (event: any) => {
          if (isFetching) setLoadingMsg(event.payload as string);
      });
      
      const args: any = { year: targetYear };
      if (empresa) args.company = empresa;

      try {
          const res = await invoke<DashboardData>("fetch_dashboard_data", args);
          
          // Se chegou aqui a tempo, desativa o "alarme" antes que a tela escura sequer apareça
          isFetching = false;
          clearTimeout(loadingTimer);
          
          setData(res); 
          // SALVA O RESULTADO NA "GAVETA" DA MEMÓRIA
          setCompanyCache(prev => ({ ...prev, [cacheKey]: res })); 
          setStatusText(empresa ? `Visualizando: ${empresa}` : "Visão Consolidada restaurada.");
      } catch (err) {
          isFetching = false;
          clearTimeout(loadingTimer);
          handleApiError(err, () => handleFetchData(empresa, targetYear));
      } finally {
          setIsLoadingData(false); // Garante que a tela de loading seja desligada sempre
          unlisten();
      }
  };

  // NOVO: O React escuta a mudança de ano no menu e atualiza os gráficos sozinho!
  useEffect(() => {
      if (!isInitialLoad) {
          handleFetchData(selectedCompany, year);
      }
  }, [year]);

  // AUTO-LIMPÁVEL: Quando o usuário abre ou foca na janela, apaga a bolinha vermelha
  useEffect(() => {
      const clearAlertIcon = () => {
          invoke('set_alert_icon', { alert: false }).catch(console.error);
      };
      
      const handleVisibility = () => {
          // Se a janela voltar a ficar visível na tela, limpa o alerta imediatamente
          if (document.visibilityState === 'visible') {
              clearAlertIcon();
          }
      };
      
      // Limpa APENAS quando a janela ganha foco ou sai do estado invisível
      window.addEventListener('focus', clearAlertIcon);
      document.addEventListener('visibilitychange', handleVisibility);
      
      return () => {
          window.removeEventListener('focus', clearAlertIcon);
          document.removeEventListener('visibilitychange', handleVisibility);
      };
  }, []);

  // ==========================================================
  // AUTO-UPDATER SILENCIOSO DO SISTEMA (A cada 6 horas)
  // ==========================================================
  useEffect(() => {
      const verifySystemUpdate = async () => {
          try {
              // 1. Pergunta para a nuvem se tem versão nova no updater.json
              const { shouldUpdate, manifest } = await checkUpdate();
              
              if (shouldUpdate) {
                  // 2. Abre a janela nativa do Windows perguntando se quer instalar
                  const wantsUpdate = await ask(
                      `A nova versão ${manifest?.version} do Monitoramento RPA está disponível!\n\nO que há de novo:\n${manifest?.body}\n\nDeseja baixar e instalar a atualização agora? O sistema será reiniciado em alguns segundos.`, 
                      { title: 'Atualização do Sistema', type: 'info' }
                  );
                  
                  // 3. Se o usuário clicar em "Sim", faz o download e reinicia sozinho!
                  if (wantsUpdate) {
                      showToast("Baixando atualização em segundo plano...", "info");
                      await installUpdate();
                      await relaunch();
                  }
              }
          } catch (error) {
              console.error("Erro na rotina de atualização automática do sistema:", error);
          }
      };

      // Dispara a cada 6 horas (21.600.000 milissegundos)
      // Usar 6 horas é mais seguro que 24h caso o computador entre em modo de suspensão
      const interval = setInterval(verifySystemUpdate, 6 * 60 * 60 * 1000);
      
      return () => clearInterval(interval);
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setTempCompany(val); 
      // Se ele digitar ou clicar num item da lista oficial, faz a busca na hora!
      if (companyList.includes(val)) {
          setSelectedCompany(val);
          handleFetchData(val, year);
      }
  };

  const clearCompanyFilter = () => { 
      setTempCompany(""); 
      setSelectedCompany(""); 
      handleFetchData("", year); 
  };

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

// RECRIA O TEXTO AZUL DO RODAPÉ QUE HAVIA SUMIDO
  const activeContext = useMemo(() => {
      const viewName = currentView === 'production_current' ? 'Produção' : 
                       currentView === 'production_compare' ? 'Ano a Ano' : 
                       currentView === 'communication' ? 'Comunicação' : 'Monitoramento';
      const detail = selectedCompany ? selectedCompany : `Visão ${source} (${year})`;
      return `Visualizando: ${viewName} ➔ ${detail}`;
  }, [currentView, selectedCompany, source, year]);

const footerStats = useMemo(() => { 
      if (!data) return { companies: 0, equipments: 0 }; 

      // Na aba de Monitoramento (MIF), o total é o MIF global
      if (currentView === 'monitoring' && monitoringData) { 
          return { companies: data.total_companies, equipments: monitoringData.mif }; 
      } 

      const totalCompanies = selectedCompany ? 1 : companyList.length;

      // 1. Filtra a fonte atual selecionada no topo (Consolidado, NDD ou iW)
      const filterFn = (d: { source: string }) => { 
          if (source === "Consolidado") return true; 
          if (source === "NDD") return d.source === "NDD"; 
          if (source === "iW") return d.source === "IW"; 
          return false; 
      };

      // 2. Pega os dados de comunicação apenas do ano escolhido e aplica o filtro de fonte
      const commData = data.communication
          .filter(c => c.ano === year)
          .filter(filterFn);

      let snapshotEquipments = 0;
      
      if (commData.length > 0) {
          // 3. Descobre qual foi o último mês que o robô baixou para esse ano
          const lastMonth = Math.max(...commData.map(c => c.mes));
          
          // 4. Soma os equipamentos (Conectados + Desconectados) do último mês
          snapshotEquipments = commData
              .filter(c => c.mes === lastMonth)
              .reduce((acc, curr) => acc + curr.connected + curr.disconnected, 0);
      }

      return { companies: totalCompanies, equipments: snapshotEquipments };
  }, [data, monitoringData, currentView, companyList, selectedCompany, year, source]);

// ---> INÍCIO DA NOVA FUNCIONALIDADE: COMPARATIVO SEMANAL REAL E HÍBRIDO
  const [showWeeklyModal, setShowWeeklyModal] = useState(false);
  const [weeklyOffset, setWeeklyOffset] = useState(0); 
  const [weeklyData, setWeeklyData] = useState<any>(null);
  const [isWeeklyLoading, setIsWeeklyLoading] = useState(false);

  useEffect(() => {
      if (!showWeeklyModal || currentView !== 'production_current') return;

      let isCancelled = false;
      setIsWeeklyLoading(true);

      const fetchRealWeeklyData = async () => {
          const today = new Date();
          let dbDate = today;
          let diasComProducaoReal = today.getDate() - 1;

          if (data?.last_update_ndd && data.last_update_ndd !== "N/D") {
              const parts = data.last_update_ndd.split('-');
              if (parts.length === 3) {
                  dbDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
                  diasComProducaoReal = parseInt(parts[2]);
              }
          }

          // INTEGRAÇÃO COM O ANO GLOBAL DO FILTRO
          let baseYear = dbDate.getFullYear();
          let baseMonth = dbDate.getMonth() + 1;
          
          if (year !== baseYear) {
              baseYear = year;
              baseMonth = 12; // Se o ano for diferente, começa explorando dezembro de trás pra frente
          }

          let targetMonth = baseMonth - weeklyOffset;
          let targetYear = baseYear;
          while (targetMonth < 1) { targetMonth += 12; targetYear -= 1; }
          let prevMonth = targetMonth - 1; let prevYear = targetYear;
          if (prevMonth < 1) { prevMonth = 12; prevYear -= 1; }

          const currKey = `${targetYear}-${targetMonth}-${source}-${selectedCompany || 'GERAL'}`;
          const prevKey = `${prevYear}-${prevMonth}-${source}-${selectedCompany || 'GERAL'}`;

          let currDaily = dailyRawCache.current[currKey];
          let prevDaily = dailyRawCache.current[prevKey];

          if (!currDaily || !prevDaily) {
              setIsWeeklyLoading(true);
              const argsCurr: any = { year: targetYear, month: targetMonth, source: source };
              const argsPrev: any = { year: prevYear, month: prevMonth, source: source };
              if (selectedCompany) { argsCurr.company = selectedCompany; argsPrev.company = selectedCompany; }
              try {
                  if (!currDaily) currDaily = await invoke("fetch_daily_production", argsCurr);
                  if (!prevDaily) prevDaily = await invoke("fetch_daily_production", argsPrev);
                  dailyRawCache.current[currKey] = currDaily;
                  dailyRawCache.current[prevKey] = prevDaily;
              } catch (e) { console.error("Erro banco:", e); }
          }
          
          if (isCancelled) return;

          const totalDiasMes = new Date(targetYear, targetMonth, 0).getDate();
          const sundays = [];
          for(let d = 1; d <= totalDiasMes; d++) {
              if (new Date(targetYear, targetMonth - 1, d).getDay() === 0) sundays.push(d);
          }

          // A MÁGICA: Só tem estimativa (Tracejado) se o mês analisado for EXATAMENTE o mês inacabado do banco de dados!
          const isCurrentOngoingMonth = (targetYear === dbDate.getFullYear() && targetMonth === (dbDate.getMonth() + 1));
          const diasRealParaEsteMes = isCurrentOngoingMonth ? diasComProducaoReal : totalDiasMes;

          const totalProduzidoAteHoje = (currDaily || []).filter(d => d.dia <= diasRealParaEsteMes).reduce((a, b) => a + b.total, 0);

          let incDiario = 0;
          if (isCurrentOngoingMonth && data && data.projection) {
              let targetProj = 0; 
              if (source === "Consolidado") { targetProj = data.projection.ndd_pb + data.projection.iw_pb + data.projection.ndd_cor + data.projection.iw_cor; }
              else if (source === "NDD") { targetProj = data.projection.ndd_pb + data.projection.ndd_cor; }
              else if (source === "iW") { targetProj = data.projection.iw_pb + data.projection.iw_cor; }

              if (targetProj > totalProduzidoAteHoje && totalDiasMes > diasRealParaEsteMes) {
                  incDiario = (targetProj - totalProduzidoAteHoje) / (totalDiasMes - diasRealParaEsteMes);
              }
          }

          const points = [];
          let acumuladoPrev = 0;
          let acumuladoCurr = 0;

          for (let d = 1; d <= totalDiasMes; d++) {
              acumuladoPrev += prevDaily?.find(x => x.dia === d)?.total || 0;
              let cReal = null; let cEst = null;

              if (d <= diasRealParaEsteMes) {
                  acumuladoCurr += currDaily?.find(x => x.dia === d)?.total || 0;
                  cReal = acumuladoCurr;
                  if (isCurrentOngoingMonth && d === diasRealParaEsteMes) cEst = acumuladoCurr;
              } else if (isCurrentOngoingMonth) {
                  cEst = Math.round(totalProduzidoAteHoje + (incDiario * (d - diasRealParaEsteMes)));
              }

              points.push({ dia: d, real_prev: acumuladoPrev > 0 ? acumuladoPrev : null, real_curr: cReal, est_curr: cEst });
          }

          setWeeklyData({ mesAtualNome: MESES[targetMonth], mesAntNome: MESES[prevMonth], points, sundays, diasRealParaEsteMes, totalDiasMes, isCurrentOngoingMonth });
          setIsWeeklyLoading(false);
      };

      fetchRealWeeklyData();
      return () => { isCancelled = true; };
  }, [showWeeklyModal, weeklyOffset, source, selectedCompany, data, year]);
  // <--- FIM DA NOVA FUNCIONALIDADE

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
          
            <div className="splash-version" style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              v3.0.2 <span style={{ color: '#455A64' }}>|</span> 
              Fonte de Dados: {isUsingLocalDB ? 'Banco Local' : 'Nuvem'} 
              {isUsingLocalDB && !syncProgressText ? <HardDrive size={12} /> : <Cloud size={12} />}
          </div>
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

      {/* --- MODAL DE AVISO DE DADOS DESATUALIZADOS --- */}
      {showDataWarning && (
        <div className="about-overlay" onClick={() => setShowDataWarning(false)} style={{ zIndex: 9999 }}>
            <div className="about-box" style={{ width: '480px', borderTop: '4px solid #FFD740' }} onClick={e => e.stopPropagation()}>
                <h2 className="about-title" style={{ color: '#FFD740' }}>Aviso de Sincronização</h2>

                <div className="about-content">
                    <p style={{ textAlign: 'justify', marginBottom: '15px' }}>
                        Identificamos que os dados de origem do <strong>{outdatedText}</strong> ainda não foram atualizados com as informações mais recentes.
                    </p>

                    {/* TABELA DE COMPARAÇÃO DE DATAS */}
                    <div style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid #455A64', borderRadius: '6px', padding: '15px', marginBottom: '15px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', borderBottom: '1px solid #37474F', paddingBottom: '4px' }}>
                            <span style={{ color: '#B0BEC5', fontWeight: 'bold' }}>Data Esperada (D-1):</span>
                            <span style={{ color: '#fff', fontWeight: 'bold' }}>{syncDates.targetBR}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                            <span style={{ color: '#B0BEC5' }}>Última Atualização NDD:</span>
                            <span style={{ color: getDateStatusColor(data?.last_update_ndd, syncDates.targetISO), fontWeight: 'bold' }}>
                                {syncDates.nddBR}
                            </span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: '#B0BEC5' }}>Última Atualização iW:</span>
                            <span style={{ color: getDateStatusColor(data?.last_update_iw, syncDates.targetISO), fontWeight: 'bold' }}>
                                {syncDates.iwBR}
                            </span>
                        </div>
                    </div>

                    <p style={{ textAlign: 'justify', marginBottom: '15px' }}>
                        Fique tranquilo! O painel continuará funcionando normalmente. As <strong>estimativas matemáticas e projeções continuam corretas</strong> com base no volume de dados que já se encontra consolidado no sistema.
                    </p>
                </div>

                <button 
                    className="btn-close-about" 
                    onClick={() => setShowDataWarning(false)} 
                    style={{ background: 'transparent', color: '#FFD740', border: '1px solid #FFD740', fontWeight: 'bold', transition: 'all 0.2s ease', marginTop: '10px' }}
                    onMouseOver={(e) => { e.currentTarget.style.background = '#FFD740'; e.currentTarget.style.color = '#000'; }}
                    onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#FFD740'; }}
                >
                    Estou Ciente
                </button>
            </div>
        </div>
      )}

      {/* --- MODAL DE MODO OFFLINE --- */}
      {showOfflineWarning && (
        <div className="about-overlay" onClick={() => setShowOfflineWarning(false)} style={{ zIndex: 10000 }}>
            <div className="about-box" style={{ width: '480px', borderTop: '4px solid #FFD740', display: 'flex', flexDirection: 'column', maxHeight: '90vh' }} onClick={e => e.stopPropagation()}>
                <h2 className="about-title" style={{ color: '#FFD740', marginBottom: 15, flexShrink: 0 }}>Modo Offline (Sem VPN)</h2>
                
                <div className="about-content" style={{ overflowY: 'auto', paddingRight: '5px', flex: 1 }}>
                    <p style={{ textAlign: 'justify', marginBottom: '15px' }}>
                        O sistema tentou se conectar à nuvem para buscar novos dados, mas a conexão falhou. <strong>Verifique se você está conectado à VPN.</strong>
                    </p>

                    <div style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid #455A64', borderRadius: '6px', padding: '15px', marginBottom: '15px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', borderBottom: '1px solid #37474F', paddingBottom: '4px' }}>
                            <span style={{ color: '#B0BEC5', fontWeight: 'bold' }}>Dados em Cache Disponíveis até:</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                            <span style={{ color: '#B0BEC5' }}>Produção NDD Print:</span>
                            <span style={{ color: '#00E5FF', fontWeight: 'bold' }}>{syncDates.nddBR}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: '#B0BEC5' }}>MIF e iW Remote:</span>
                            <span style={{ color: '#00E5FF', fontWeight: 'bold' }}>{syncDates.iwBR}</span>
                        </div>
                    </div>

                    {/* LÓGICA INTELIGENTE: AVALIA SE O CACHE JÁ ESTÁ EM DIA (D-1) */}
                    {syncDates.nddISO !== "N/D" && syncDates.iwISO !== "N/D" && syncDates.nddISO >= syncDates.targetISO && syncDates.iwISO >= syncDates.targetISO ? (
                        <div style={{ background: 'rgba(0, 230, 118, 0.1)', border: '1px solid rgba(0, 230, 118, 0.4)', borderRadius: '4px', padding: '10px', marginBottom: '15px' }}>
                            <p style={{ textAlign: 'justify', margin: 0, color: '#00E676', fontSize: '11.5px' }}>
                                <strong>Fique tranquilo!</strong> Embora não haja conexão com a nuvem, o cache salvo no seu computador <strong>já possui os dados atualizados (D-1)</strong>. Suas análises não serão prejudicadas!
                            </p>
                        </div>
                    ) : (
                        <p style={{ textAlign: 'justify', marginBottom: '15px', color: '#B0BEC5', fontSize: '11px' }}>
                            Você pode usar o painel com os dados locais normalmente. Assim que conectar à VPN, clique no ícone de <strong>Atualizar</strong> no rodapé para tentar novamente.
                        </p>
                    )}
                </div>

                <button 
                    className="btn-close-about" 
                    onClick={() => setShowOfflineWarning(false)} 
                    style={{ background: 'transparent', color: '#FFD740', border: '1px solid #FFD740', fontWeight: 'bold', width: '100%', marginTop: '15px', flexShrink: 0, transition: 'all 0.2s ease' }}
                    onMouseOver={(e) => { e.currentTarget.style.background = '#FFD740'; e.currentTarget.style.color = '#000'; }}
                    onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#FFD740'; }}
                >
                    ESTOU CIENTE
                </button>
            </div>
        </div>
      )}

      {/* --- MODAL DE SISTEMA ATUALIZADO --- */}
      {showNoUpdateModal && (
        <div className="about-overlay" onClick={() => setShowNoUpdateModal(false)} style={{ zIndex: 10000 }}>
            <div className="about-box" style={{ width: '400px', borderTop: '4px solid #00E676' }} onClick={e => e.stopPropagation()}>
                <h2 className="about-title" style={{ color: '#00E676', marginBottom: 15 }}>Sistema Atualizado</h2>
                
                <div className="about-content" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    
                    {/* ANIMAÇÃO DE SUCESSO PROFISSIONAL */}
                    <div style={{ position: 'relative', width: '64px', height: '64px', marginTop: '20px', marginBottom: '25px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <style>
                            {`
                                @keyframes popInCheck {
                                    0% { transform: scale(0); opacity: 0; }
                                    60% { transform: scale(1.2); opacity: 1; }
                                    100% { transform: scale(1); opacity: 1; }
                                }
                                @keyframes pulseSuccess {
                                    0% { box-shadow: 0 0 0 0 rgba(0, 230, 118, 0.3); }
                                    70% { box-shadow: 0 0 0 15px rgba(0, 230, 118, 0); }
                                    100% { box-shadow: 0 0 0 0 rgba(0, 230, 118, 0); }
                                }
                                .animated-check-icon {
                                    animation: popInCheck 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards;
                                    z-index: 2;
                                }
                                .animated-check-bg {
                                    position: absolute;
                                    width: 100%;
                                    height: 100%;
                                    border-radius: 50%;
                                    background: rgba(0, 230, 118, 0.1);
                                    animation: pulseSuccess 2s infinite;
                                    z-index: 1;
                                }
                            `}
                        </style>
                        <div className="animated-check-bg"></div>
                        <div className="animated-check-icon" style={{ color: '#00E676', display: 'flex' }}>
                            <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                                <polyline points="22 4 12 14.01 9 11.01"></polyline>
                            </svg>
                        </div>
                    </div>
                    {/* FIM DA ANIMAÇÃO */}

                    <p style={{ textAlign: 'center', marginBottom: '15px', color: '#B0BEC5' }}>
                        Não há novos dados disponíveis na nuvem neste momento. Seu painel já está com as informações mais recentes!
                    </p>
                </div>

                <button 
                    className="btn-close-about" 
                    onClick={() => setShowNoUpdateModal(false)} 
                    style={{ background: 'transparent', color: '#00E676', border: '1px solid #00E676', fontWeight: 'bold', width: '100%', marginTop: '10px', transition: 'all 0.2s ease' }}
                    onMouseOver={(e) => { e.currentTarget.style.background = '#00E676'; e.currentTarget.style.color = '#000'; }}
                    onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#00E676'; }}
                >
                    OK
                </button>
            </div>
        </div>
      )}

      {/* --- MODAL: O QUE HÁ DE NOVO --- */}
      {showWhatsNew && (
        <div className="about-overlay" onClick={() => setShowWhatsNew(false)} style={{ zIndex: 10000 }}>
            <div className="about-box" style={{ width: '580px', borderTop: '4px solid #00E5FF' }} onClick={e => e.stopPropagation()}>
                <h2 className="about-title" style={{ color: '#00E5FF', marginBottom: '5px' }}>🚀 A Grande Atualização 3.0.2</h2>
                <p style={{ fontSize: '12px', color: '#B0BEC5', marginBottom: '20px' }}>Um salto em Experiência do Usuário (UX) e Inteligência de Dados</p>

                <div className="about-content" style={{ maxHeight: '60vh', overflowY: 'auto', paddingRight: '10px' }}>
                    
                    <div style={{ marginBottom: '15px', background: 'rgba(0,0,0,0.2)', padding: '12px', borderRadius: '6px', borderLeft: '3px solid #00E5FF' }}>
                        <h4 style={{ color: '#fff', marginBottom: '5px', fontSize: '13px' }}>🔔 Notificações Inteligentes e Interativas</h4>
                        <p style={{ fontSize: '12px', color: '#B0BEC5', textAlign: 'justify', margin: 0, lineHeight: '1.4' }}>
                            Adeus balões cinzas! Agora o sistema possui um motor próprio de alertas. Notificações flutuantes ricas em gráficos, barras de progresso e números gigantes alertam sobre o fechamento do mês. <strong>Clique nelas para ser redirecionado automaticamente à aba certa do sistema (Deep Linking)</strong>.
                        </p>
                    </div>

                    <div style={{ marginBottom: '15px', background: 'rgba(0,0,0,0.2)', padding: '12px', borderRadius: '6px', borderLeft: '3px solid #00E676' }}>
                        <h4 style={{ color: '#fff', marginBottom: '5px', fontSize: '13px' }}>🧠 Sincronização Pensante (Smart Sync)</h4>
                        <p style={{ fontSize: '12px', color: '#B0BEC5', textAlign: 'justify', margin: 0, lineHeight: '1.4' }}>
                            O robô de background agora pensa antes de agir. Ao iniciar, ele compara os dias das datas locais com a nuvem e <strong>só baixa pacotes novos se houver real necessidade</strong>, reduzindo drastically o uso de rede e CPU no momento que você abre o programa.
                        </p>
                    </div>

                    <div style={{ marginBottom: '15px', background: 'rgba(0,0,0,0.2)', padding: '12px', borderRadius: '6px', borderLeft: '3px solid #FFD740' }}>
                        <h4 style={{ color: '#fff', marginBottom: '5px', fontSize: '13px' }}>🎨 Termômetro Visual de Saúde (Rodapé)</h4>
                        <p style={{ fontSize: '12px', color: '#B0BEC5', textAlign: 'justify', margin: 0, lineHeight: '1.4' }}>
                            Basta um olhar para o rodapé para saber a integridade do banco de dados. As datas de atualização agora usam uma paleta orgânica: ficam <strong>Verdes</strong> se estiverem em dia, <strong>Amarelas</strong> para pequenos atrasos aceitáveis e <strong>Vermelhas</strong> se a defasagem for crítica.
                        </p>
                    </div>

                    <div style={{ marginBottom: '10px', background: 'rgba(0,0,0,0.2)', padding: '12px', borderRadius: '6px', borderLeft: '3px solid #E040FB' }}>
                        <h4 style={{ color: '#fff', marginBottom: '5px', fontSize: '13px' }}>📊 Ranking Top 5 Aprimorado</h4>
                        <p style={{ fontSize: '12px', color: '#B0BEC5', textAlign: 'justify', margin: 0, lineHeight: '1.4' }}>
                            O ranking de empresas na notificação ganhou um visual de barras neon. Ele exibe com precisão o mês analisado, ajusta os números longos com pontuações (ex: 4.654.321) e esconde graciosamente nomes de empresas gigantes para não quebrar a tela.
                        </p>
                    </div>

                </div>

                <button 
                    className="btn-close-about" 
                    onClick={() => setShowWhatsNew(false)} 
                    style={{ marginTop: '20px', width: '100%', background: 'transparent', color: '#00E5FF', fontWeight: 'bold', border: '1px solid #00E5FF', transition: 'all 0.2s ease' }}
                    onMouseOver={(e) => { e.currentTarget.style.background = '#00E5FF'; e.currentTarget.style.color = '#000'; }}
                    onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#00E5FF'; }}
                >
                    Começar a usar a v3.0.2
                </button>
            </div>
        </div>
      )}

    {/* --- MODAL SOBRE (ABOUT) --- */}
      {showAbout && (
        <div className="about-overlay" onClick={() => setShowAbout(false)}>
            <div className="about-box" style={{ width: '450px' }} onClick={e => e.stopPropagation()}>
                <h2 className="about-title">Monitoramento RPA</h2>
                <p className="about-version">Versão 3.0.2</p>
                
                <div className="about-content">
                    <p style={{textAlign: 'justify', marginBottom: '15px'}}>
                        O <strong>Monitoramento RPA</strong> é uma ferramenta analítica de alto desempenho projetada para consolidar e auditar o parque de impressões. 
                        A aplicação unifica dados de telemetria do <strong>NDD Print</strong> e do <strong>Canon iW Remote</strong>, oferecendo uma visão centralizada sobre a produção de páginas, saúde de comunicação dos equipamentos e acompanhamento preciso das metas de monitoramento em todo o ecossistema corporativo.
                    </p>

                    <div style={{ borderTop: '1px solid #455A64', margin: '15px 0' }}></div>

                    <h3 style={{ color: '#fff', fontSize: '13px', marginBottom: '12px', textAlign: 'center', textTransform: 'uppercase', letterSpacing: '1px' }}>
                        Stack Tecnológico
                    </h3>
                    
                    {/* Grid em duas colunas atualizado com as versões reais da v2.0.1 */}
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '12px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                        <li><span style={{color: '#00E5FF'}}>■</span> <b>Tauri:</b> v1.6 (Desktop Engine)</li>
                        <li><span style={{color: '#00E5FF'}}>■</span> <b>Rust:</b> v1.92.0 (Core Backend)</li>
                        <li><span style={{color: '#00E5FF'}}>■</span> <b>React:</b> v19.1.0 (Interface)</li>
                        <li><span style={{color: '#00E5FF'}}>■</span> <b>TypeScript:</b> v5.8.3 (Tipagem)</li>
                        <li><span style={{color: '#00E5FF'}}>■</span> <b>Vite:</b> v7.3.1 (Build Tool)</li>
                        <li><span style={{color: '#00E5FF'}}>■</span> <b>Recharts:</b> v3.6.0 (Gráficos)</li>
                        <li><span style={{color: '#00E676'}}>■</span> <b>SQLx:</b> v0.6.3 (Conexão BD)</li>
                        <li><span style={{color: '#00E676'}}>■</span> <b>SQLite:</b> v3 (Local Cache WAL)</li>
                        <li><span style={{color: '#FFD740'}}>■</span> <b>Tokio:</b> v1.x (Async Workers)</li>
                        <li><span style={{color: '#00E5FF'}}>■</span> <b>Lucide:</b> v0.562.0 (Ícones)</li>
                    </ul>

                    <div style={{ borderTop: '1px solid #455A64', margin: '15px 0' }}></div>
                    
                    <p style={{ fontSize: '11px', textAlign: 'center', color: '#78909C', fontStyle: 'italic' }}>
                        Desenvolvido com arquitetura assíncrona para alta performance, utilizando processamento nativo em segundo plano e gerenciamento inteligente de memória em cache.
                    </p>
                </div>

                <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
                    <button 
                        className="btn-close-about" 
                        onClick={() => { setShowAbout(false); setShowWhatsNew(true); }} 
                        style={{ flex: 1, background: 'transparent', color: '#00E676', border: '1px solid #00E676', transition: 'all 0.2s ease' }}
                        onMouseOver={(e) => { e.currentTarget.style.background = '#00E676'; e.currentTarget.style.color = '#000'; }}
                        onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#00E676'; }}
                    >
                        Ver Novidades
                    </button>
                    <button className="btn-close-about" onClick={() => setShowAbout(false)} style={{ flex: 1 }}>
                        Fechar
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
                                            <td 
                                                style={{
                                                    fontWeight: 'bold', color: '#fff', fontSize: 11, 
                                                    maxWidth: '280px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                                                }} 
                                                title={row.empresa}
                                            >
                                                {row.empresa}
                                            </td>
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

          {!panelLoading && displayedData.length > 0 && (() => {
              // Calcula os índices do primeiro e último item sendo exibidos na página atual
              const startItem = (currentPage - 1) * itemsPerPage + 1;
              const endItem = Math.min(currentPage * itemsPerPage, displayedData.length);
              
              return (
                  <div className="pagination" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                          {/* Tag (Badge) destacada para a Página */}
                          <div style={{ 
                              background: 'rgba(0, 229, 255, 0.1)', 
                              border: '1px solid rgba(0, 229, 255, 0.3)', 
                              borderRadius: '4px', 
                              padding: '4px 10px', 
                              color: '#00E5FF', 
                              fontWeight: 'bold', 
                              fontSize: '11px', 
                              letterSpacing: '0.5px' 
                          }}>
                              PÁG. {currentPage} / {totalPages}
                          </div>
                          
                          {/* Texto de Contagem de Registros */}
                          <span style={{ color: '#B0BEC5', fontSize: '12px' }}>
                              Exibindo <b style={{ color: '#fff' }}>{fmtMilhar(startItem)}</b> a <b style={{ color: '#fff' }}>{fmtMilhar(endItem)}</b> de <b style={{ color: '#fff' }}>{fmtMilhar(displayedData.length)}</b> registros
                          </span>
                      </div>
                      
                      <div style={{ display: 'flex', gap: '8px' }}>
                          <button className="page-btn" style={{ margin: 0 }} disabled={currentPage === 1} onClick={() => setCurrentPage(p => p - 1)}>Anterior</button>
                          <button className="page-btn" style={{ margin: 0 }} disabled={currentPage === totalPages} onClick={() => setCurrentPage(p => p + 1)}>Próxima</button>
                      </div>
                  </div>
              );
          })()}
      </div>

    {/* --- MODAL DO COMPARATIVO SEMANAL --- */}
      {showWeeklyModal && (
        <div className="about-overlay" onClick={() => setShowWeeklyModal(false)} style={{ zIndex: 9999 }}>
            <div className="about-box" style={{ width: '850px', maxWidth: '95%', borderTop: '4px solid #00E5FF', minHeight: '400px', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
                
                {!weeklyData ? (
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
                        <div style={{ color: '#00E5FF', fontWeight: 'bold', fontSize: '16px' }}>Montando modelo diário...</div>
                        <div style={{ color: '#B0BEC5', fontSize: '12px', marginTop: '10px' }}>Carregando e analisando os dados.</div>
                    </div>
                ) : (
                    <>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '20px' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                                    <h2 className="about-title" style={{ marginBottom: 0, color: '#00E5FF', textAlign: 'left' }}>Evolução Semanal Acumulada</h2>
                                    
                                    <div className="month-nav" style={{ display: 'flex', gap: 10 }}>
                                        <button className="nav-btn" onClick={() => setWeeklyOffset(prev => prev + 1)} title="Mês Anterior">{'<'}</button>
                                        <button className="nav-btn" disabled={weeklyOffset === 0} onClick={() => setWeeklyOffset(prev => prev - 1)} title="Mês Mais Recente">{'>'}</button>
                                    </div>
                                </div>
                                <div style={{ fontSize: '12px', color: '#B0BEC5', marginTop: '4px', textAlign: 'left' }}>Acompanhamento do fechamento</div>
                            </div>
                            
                            {/* NOVO LADO DIREITO: FILTROS GLOBAIS E LEGENDA */}
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '10px' }}>
                                <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end' }}>
                                    {/* Empresa */}
                                    <div style={{ position: 'relative' }}>
                                        <span style={{ fontSize: '9px', fontWeight: 'bold', color: '#B0BEC5', position: 'absolute', top: '-13px', left: '0' }}>EMPRESA</span>
                                        <input 
                                            list="companies-modal" placeholder={areCompaniesReady ? "Todas..." : "Carregando..."} value={tempCompany} onChange={handleInputChange} disabled={!areCompaniesReady} 
                                            style={{ background: '#263238', color: '#fff', border: '1px solid #546E7A', borderRadius: '4px', padding: '0 8px', fontSize: '11px', width: '120px', height: '24px', boxSizing: 'border-box', outline: 'none' }} 
                                        />
                                        {tempCompany && <button onClick={clearCompanyFilter} style={{ position: 'absolute', right: '4px', top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 'none', color: '#B0BEC5', cursor: 'pointer', fontSize: '11px', padding: 0 }}>✕</button>}
                                        <datalist id="companies-modal">{companyList.map((c, i) => <option key={i} value={c} />)}</datalist>
                                    </div>
                                    
                                    {/* Ano */}
                                    <div style={{ position: 'relative' }}>
                                        <span style={{ fontSize: '9px', fontWeight: 'bold', color: '#B0BEC5', position: 'absolute', top: '-13px', left: '0' }}>ANO</span>
                                        <select value={year} onChange={e => { setYear(Number(e.target.value)); setWeeklyOffset(0); }} style={{ background: '#263238', color: '#00E5FF', border: '1px solid #546E7A', borderRadius: '4px', padding: '0 8px', fontSize: '11px', width: '120px', height: '24px', boxSizing: 'border-box', outline: 'none', cursor: 'pointer' }}>
                                            {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
                                        </select>
                                    </div>
                                    
                                    {/* Fonte */}
                                    <div style={{ position: 'relative' }}>
                                        <span style={{ fontSize: '9px', fontWeight: 'bold', color: '#B0BEC5', position: 'absolute', top: '-13px', left: '0' }}>FONTE</span>
                                        <select value={source} onChange={e => setSource(e.target.value)} style={{ background: '#263238', color: '#00E5FF', border: '1px solid #546E7A', borderRadius: '4px', padding: '0 8px', fontSize: '11px', width: '120px', height: '24px', boxSizing: 'border-box', outline: 'none', cursor: 'pointer' }}>
                                            <option value="Consolidado">Consolidado</option><option value="NDD">NDD</option><option value="iW">iW</option>
                                        </select>
                                    </div>
                                </div>

                                <div style={{ display: 'flex', gap: '15px', fontSize: '12px', fontWeight: 'bold' }}>
                                    <div style={{ color: '#B0BEC5' }}><span style={{color: '#546E7A', fontSize: '14px'}}>■</span> {weeklyData.mesAntNome}</div>
                                    <div style={{ color: '#fff' }}><span style={{color: '#00E5FF', fontSize: '14px'}}>■</span> {weeklyData.mesAtualNome}</div>
                                </div>
                            </div>
                        </div>
                        
                        <div style={{ position: 'relative', width: '100%', height: '350px' }}>
                            {/* Overlay com Spinner flutuando em cima do gráfico */}
                            {isWeeklyLoading && (
                                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 10, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                                    <div className="loading-spinner" style={{ width: '40px', height: '40px' }}></div>
                                </div>
                            )}

                            {/* O Gráfico em si, que agora recebe o efeito animado de Blur */}
                            <div style={{ 
                                boxSizing: 'border-box', /* <--- MÁGICA QUE RESOLVE A SOBREPOSIÇÃO AQUI */
                                height: '100%', width: '100%', background: 'rgba(0,0,0,0.2)', padding: '15px', borderRadius: '8px', border: '1px solid #37474F',
                                filter: isWeeklyLoading ? 'blur(4px)' : 'none',
                                opacity: isWeeklyLoading ? 0.5 : 1,
                                transition: 'all 0.3s ease',
                                pointerEvents: isWeeklyLoading ? 'none' : 'auto'
                            }}>
                                <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={weeklyData.points} margin={{ top: 55, right: 55, left: 20, bottom: 5 }}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#37474F" vertical={false} />
                                    
                                    <XAxis dataKey="dia" type="number" domain={[1, weeklyData.totalDiasMes]} ticks={weeklyData.sundays} tickFormatter={(val) => `S${weeklyData.sundays.indexOf(val) + 1} (Dia ${val})`} stroke="#B0BEC5" tick={{fontSize: 11}} />
                                    <YAxis stroke="#B0BEC5" tickFormatter={(val) => `${(val/1000000).toFixed(1)}M`} tick={{fontSize: 11}} />
                                    
                                    {/* Tooltip atualizado agora recebe o isCurrentOngoingMonth */}
                                    <Tooltip content={<WeeklyEvolutionTooltip weeklyData={weeklyData} isCurrentOngoingMonth={weeklyData.isCurrentOngoingMonth} />} cursor={{ fill: 'transparent' }} />
                                    
                                    {/* Linha Vertical usa o Source Global */}
                                    {weeklyData.isCurrentOngoingMonth && weeklyData.diasRealParaEsteMes > 0 && weeklyData.diasRealParaEsteMes < weeklyData.totalDiasMes && (
                                        <ReferenceLine x={weeklyData.diasRealParaEsteMes} stroke="#B0BEC5" strokeWidth={2} strokeDasharray="3 3" label={<RenderVerticalLineLabel weeklySource={source} nddDate={formatDate(data?.last_update_ndd)} iwDate={formatDate(data?.last_update_iw)} />} />
                                    )}

                                    {/* As Tags do Gráfico com o parâmetro allPoints */}
                                    <Line name="Mês Anterior" type="monotone" dataKey="real_prev" stroke="#546E7A" strokeWidth={3} dot={(props) => <RenderCustomDot {...props} sundays={weeklyData.sundays} />} activeDot={{ r: 6 }} label={(props) => <RenderWeeklyLabel {...props} sundays={weeklyData.sundays} lineKey="real_prev" color="#90A4AE" currentDay={weeklyData.diasRealParaEsteMes} isCurrentOngoingMonth={weeklyData.isCurrentOngoingMonth} totalDiasMes={weeklyData.totalDiasMes} allPoints={weeklyData.points} />} />
                                    
                                    <Line name="Real" type="monotone" dataKey="real_curr" stroke="#00E5FF" strokeWidth={4} dot={(props) => <RenderCustomDot {...props} sundays={weeklyData.sundays} />} activeDot={{ r: 7 }} label={(props) => <RenderWeeklyLabel {...props} sundays={weeklyData.sundays} lineKey="real_curr" color="#00E5FF" currentDay={weeklyData.diasRealParaEsteMes} isCurrentOngoingMonth={weeklyData.isCurrentOngoingMonth} totalDiasMes={weeklyData.totalDiasMes} allPoints={weeklyData.points} />} />
                                    
                                    <Line name="Estimativa" type="monotone" dataKey="est_curr" stroke="#FFD740" strokeWidth={3} strokeDasharray="6 4" dot={(props) => <RenderCustomDot {...props} sundays={weeklyData.sundays} />} activeDot={{ r: 5 }} label={(props) => <RenderWeeklyLabel {...props} sundays={weeklyData.sundays} lineKey="est_curr" color="#FFD740" currentDay={weeklyData.diasRealParaEsteMes} isCurrentOngoingMonth={weeklyData.isCurrentOngoingMonth} totalDiasMes={weeklyData.totalDiasMes} allPoints={weeklyData.points} />} legendType="none" />                                </LineChart> 
                            </ResponsiveContainer>
                        </div>
                        </div> {/* <--- NOVO FECHAMENTO AQUI! */}

                        <button className="btn-close-about" style={{ marginTop: '20px', width: '100%' }} onClick={() => setShowWeeklyModal(false)}>
                            Fechar Relatório
                        </button>
                    </>
                )}
            </div>
        </div>
      )}

      {!isInitialLoad && (
      <div className={`container ${isLoadingData ? 'blurred' : ''}`}>
        <header style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'start', minHeight: '65px', paddingBottom: '10px', gap: '10px' }}>
          
          {/* 1. ESQUERDA: Botões das abas (Alinhados ao início) */}
          <div className="left-controls" style={{ display: 'flex', justifyContent: 'flex-start' }}>
            <div className="view-selector">
                <button onClick={() => setCurrentView('production_current')} className={currentView === 'production_current' ? 'active' : ''}>Produção</button>
                <button onClick={() => setCurrentView('production_compare')} className={currentView === 'production_compare' ? 'active' : ''}>Ano a Ano</button>
                <button onClick={() => setCurrentView('communication')} className={currentView === 'communication' ? 'active' : ''}>Comunicação</button>
                <button onClick={() => setCurrentView('monitoring')} className={currentView === 'monitoring' ? 'active' : ''}>Monitoramento</button>
            </div>
          </div>
          
          {/* 2. CENTRO: Título e Botão (Garantidos no centro sem sobreposição) */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
              <h2 style={{ margin: 0, whiteSpace: 'nowrap' }}>
                {currentView === 'production_compare' ? `Comparativo ${year} vs ${year-1}` : currentView === 'communication' ? 'Status de Comunicação' : currentView === 'monitoring' ? 'Monitoramento de Parque (MIF)' : 'Visão Geral de Produção'}
              </h2>
              
              {/* Botão Retangular Profissional com Ícone Lucide */}
              {currentView === 'production_current' && (
                  <button 
                      onClick={() => { 
                          setWeeklyOffset(0);
                          setShowWeeklyModal(true); 
                      }}
                      style={{ 
                          background: 'rgba(0, 229, 255, 0.08)', 
                          color: '#00E5FF', 
                          border: '1px solid rgba(0, 229, 255, 0.15)', 
                          padding: '6px 14px', 
                          borderRadius: '4px', 
                          fontSize: '11px', 
                          fontWeight: 'bold',
                          cursor: 'pointer',
                          display: 'flex', 
                          alignItems: 'center', 
                          gap: '6px', 
                          marginTop: '6px',
                          transition: 'all 0.2s ease'
                      }}
                      onMouseOver={(e) => { e.currentTarget.style.background = 'rgba(0, 229, 255, 0.15)'; }}
                      onMouseOut={(e) => { e.currentTarget.style.background = 'rgba(0, 229, 255, 0.08)'; }}
                  >
                      <TrendingUp size={18} color="#00E5FF" /> 
                      Previsões Semanais
                  </button>
              )}
          </div>
          
          {/* 3. DIREITA: Filtros (Mais próximos e alinhados ao final) */}
          {currentView !== 'monitoring' ? (
            <div className="filters" style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
               
               <div className="filter-group">
                   <label>Empresa</label>
                   <div className="input-wrapper">
                       <input list="companies" placeholder={areCompaniesReady ? "Todas..." : "Preparando lista..."} value={tempCompany} onChange={handleInputChange} disabled={!areCompaniesReady} style={!areCompaniesReady ? {cursor: 'wait', opacity: 0.7} : {}} />
                       {tempCompany && <button className="clear-btn" onClick={clearCompanyFilter}>✕</button>}
                       <datalist id="companies">{companyList.map((c, i) => <option key={i} value={c} />)}</datalist>
                   </div>
               </div>
               
               <div className="filter-group">
                   <label>Ano</label>
                   <select value={year} onChange={e => setYear(Number(e.target.value))}>
                       {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
                   </select>
               </div>
               
               <div className="filter-group">
                   <label>Fonte</label>
                   <select value={source} onChange={e => setSource(e.target.value)}>
                       <option value="Consolidado">Consolidado</option>
                       <option value="NDD">NDD</option>
                       <option value="iW">iW</option>
                   </select>
               </div>
               
            </div>
          ) : <div /> /* Div vazia necessária para manter a estrutura de 3 colunas do Grid */}
        </header>

        <div className="chart-frame">
            {currentView === 'monitoring' ? ( 
                <MonitoringView 
                    data={monitoringData} 
                    dashboardData={data} 
                    companySummaries={companySummaries}
                    isLoadingSummaries={isLoadingSummaries}
                    showToast={showToast}
                /> 
            ) : (
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


{/* =========================================================
            PAINEL DE DESENVOLVEDOR SECRETO (TESTES V3.0.2)
            ========================================================= */}
        {showDebugMenu && (
            <div style={{
                position: 'absolute', top: '70px', right: '20px', width: '220px',
                background: 'rgba(20, 20, 20, 0.95)', border: '1px solid #00E5FF',
                borderRadius: '6px', padding: '15px', zIndex: 9000,
                display: 'flex', flexDirection: 'column', gap: '5px',
                boxShadow: '0 0 20px rgba(0, 229, 255, 0.3)'
            }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                    <h4 style={{ color: '#00E5FF', margin: 0, fontSize: '11px', textTransform: 'uppercase' }}>
                        🛠️ Modo Dev (Tray)
                    </h4>
                    <button 
                        onClick={() => setShowDebugMenu(false)}
                        style={{ background: 'transparent', border: 'none', color: '#EF5350', cursor: 'pointer', fontWeight: 'bold', padding: 0 }}
                    >
                        ✕
                    </button>
                </div>
                
                <span style={{ fontSize: '9px', color: '#B0BEC5' }}>Testar Notificações Inteligentes:</span>
                <button 
                    onClick={() => {
                        showToast("Minimize o app correndo! A rotina vai rodar em 3 segundos...", "info");
                        setTimeout(() => handleManualSync('morning'), 3000);
                    }} 
                    className="page-btn" 
                    style={{ margin: 0, padding: '6px', fontSize: '10px', background: 'rgba(0, 229, 255, 0.1)', border: '1px solid #00E5FF', color: '#00E5FF' }}
                >
                    🌅 Iniciar Rotina Real (08:30)
                </button>
                <button onClick={() => invoke('debug_trigger_notification', { alertType: 'risk' })} className="page-btn" style={{ margin: 0, padding: '6px', fontSize: '10px', color: '#FFD740' }}>⚠️ Risco de Meta</button>
                <button onClick={() => invoke('debug_trigger_notification', { alertType: 'anomaly' })} className="page-btn" style={{ margin: 0, padding: '6px', fontSize: '10px', color: '#EF5350' }}>🚨 Anomalia</button>
                <button onClick={() => invoke('debug_trigger_notification', { alertType: 'celebration' })} className="page-btn" style={{ margin: 0, padding: '6px', fontSize: '10px', color: '#00E676' }}>🏆 Celebração (Meta)</button>
                <button onClick={() => invoke('debug_trigger_notification', { alertType: 'top5' })} className="page-btn" style={{ margin: 0, padding: '6px', fontSize: '10px' }}>📈 Top 5 Empresas</button>

                <span style={{ fontSize: '9px', color: '#B0BEC5', marginTop: '10px' }}>Testar Tooltip da Bandeja:</span>
                <button onClick={() => invoke('debug_set_tray_status', { status: 'success' })} className="page-btn" style={{ margin: 0, padding: '6px', fontSize: '10px', color: '#00E676' }}>🟢 Simular: Atualizado</button>
                <button onClick={() => invoke('debug_set_tray_status', { status: 'syncing' })} className="page-btn" style={{ margin: 0, padding: '6px', fontSize: '10px', color: '#FFD740' }}>🟡 Simular: Baixando</button>
                <button onClick={() => invoke('debug_set_tray_status', { status: 'outdated' })} className="page-btn" style={{ margin: 0, padding: '6px', fontSize: '10px', color: '#EF5350' }}>🔴 Simular: Velho</button>
                <span style={{ fontSize: '9px', color: '#B0BEC5', marginTop: '10px' }}>Testar Sistema de Alerta Visual:</span>
                <button onClick={() => invoke('set_alert_icon', { alert: true })} className="page-btn" style={{ margin: 0, padding: '6px', fontSize: '10px', color: '#EF5350' }}>🔴 Acender Bolinha de Alerta (Tray/Taskbar)</button>

        {/* --- NOVO BOTÃO DE TESTE DO UPDATER --- */}
                <span style={{ fontSize: '9px', color: '#B0BEC5', marginTop: '10px' }}>Testar Auto-Updater:</span>
                <button 
                    onClick={async () => {
                        try {
                            showToast("A procurar atualizações no GitHub...", "info");
                            const { shouldUpdate, manifest } = await checkUpdate();
                            
                            if (shouldUpdate) {
                                const wantsUpdate = await ask(
                                    `A nova versão ${manifest?.version} do Monitoramento RPA está disponível!\n\nO que há de novo:\n${manifest?.body}\n\nDeseja testar a transferência e instalação agora?`, 
                                    { title: 'Teste de Atualização', type: 'info' }
                                );
                                
                                if (wantsUpdate) {
                                    showToast("A transferir a atualização em segundo plano...", "info");
                                    await installUpdate();
                                    await relaunch();
                                }
                            } else {
                                showToast("Nenhuma versão nova encontrada. Já possui a mais recente!", "success");
                            }
                        } catch (error) {
                            console.error("Erro ao testar o updater:", error);
                            showToast("Falha ao comunicar com o GitHub. Verifique a consola.", "info");
                        }
                    }} 
                    className="page-btn" 
                    style={{ margin: 0, padding: '6px', fontSize: '10px', color: '#00E676', border: '1px solid #00E676', background: 'rgba(0, 230, 118, 0.1)' }}
                >
                    🔄 Forçar Verificação de Atualização
                </button>
            </div>
        )}
        {/* ========================================================= */}

        <footer>
            <div className="footer-left">
                {/* O GATILHO SECRETO: A Dica em texto foi removida! */}
                <span 
                    style={{ color: '#B0BEC5', marginRight: '5px', cursor: 'default' }}
                    onDoubleClick={() => setShowDebugMenu(true)}
                >
                    Atualizado em:
                </span>
                
                <div 
                    className="footer-item" 
                    title={syncDates.nddISO !== "N/D" && syncDates.nddISO >= syncDates.targetISO ? "✅ Banco de dados atualizado" : `⚠️ Desatualizado (Esperado: ${syncDates.targetBR})`} 
                    style={{cursor: 'help'}}
                >
                    <span>NDD:&nbsp;</span> 
                    <b style={{ color: getDateStatusColor(data?.last_update_ndd, syncDates.targetISO), transition: 'color 0.3s ease' }}>
                        {formatDate(data?.last_update_ndd)}
                    </b>
                </div>
                
                <div className="separator">|</div>
                
                <div 
                    className="footer-item" 
                    title={syncDates.iwISO !== "N/D" && syncDates.iwISO >= syncDates.targetISO ? "✅ Banco de dados atualizado" : `⚠️ Desatualizado (Esperado: ${syncDates.targetBR})`} 
                    style={{cursor: 'help'}}
                >
                    <span>iW:&nbsp;</span>
                    <b style={{ color: getDateStatusColor(data?.last_update_iw, syncDates.targetISO), transition: 'color 0.3s ease' }}>
                        {formatDate(data?.last_update_iw)}
                    </b>
                </div>
            </div>
            <div className="footer-right" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              
              {/* ESTATÍSTICAS */}
              {currentView !== 'monitoring' && <>
                  <span className="footer-stat" title="Total de empresas ativas no ano selecionado">Empresas: <b>{footerStats.companies.toLocaleString()}</b></span>
                  <span className="separator">|</span>
                  <span className="footer-stat">Eqp: <b>{footerStats.equipments.toLocaleString()}</b></span>
              </>}

              {/* BLOCO FINAL: TEXTOS E ÍCONES EMPILHADOS */}
              <div style={{ display: 'flex', alignItems: 'center', borderLeft: '1px solid #455A64', paddingLeft: '15px', marginLeft: '5px' }}>
                  
                  {/* COLUNA DE TEXTOS (Alinhados à direita) */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', justifyContent: 'center', marginRight: '10px', minWidth: '220px' }}>
                      
                      {/* LINHA DE CIMA: Onde o usuário está navegando (Azul) */}
                      <span style={{ color: '#00E5FF', fontSize: '11px', marginBottom: '4px' }}>
                          {activeContext}
                      </span>
                      
                      {/* LINHA DE BAIXO: Processos em Background (Amarelo SEM negrito) */}
                      <div style={{ display: 'flex', alignItems: 'center', height: '14px', position: 'relative', width: '100%', justifyContent: 'flex-end' }}>
                          {hasSyncFailed && !syncProgressText && !bgLoading && !(syncDates.nddISO !== "N/D" && syncDates.iwISO !== "N/D" && syncDates.nddISO >= syncDates.targetISO && syncDates.iwISO >= syncDates.targetISO) ? (
                              <span style={{ color: '#FFD740', fontSize: '11px', fontStyle: 'italic', opacity: 0.9 }}>
                                  Clique para atualizar ➔
                              </span>
                          ) : syncProgressText ? (
                              <span style={{ 
                                  color: syncProgressText.includes("100%") ? '#00E676' : '#FFD740', // Fica Verde se for sucesso
                                  fontSize: '11px', fontWeight: 'normal', display: 'flex', alignItems: 'center', margin: 0 
                              }}>
                                  {!syncProgressText.includes("100%") && ( // Oculta o Spinner se for 100%
                                      <span className="footer-spinner" style={{ marginRight: '5px', width: '10px', height: '10px', borderWidth: '2px', borderColor: 'rgba(255, 215, 64, 0.2)', borderTopColor: '#FFD740' }}></span>
                                  )}
                                  {syncProgressText}
                              </span>
                          ) : statusText && !statusText.startsWith("Visualizando") && statusText !== "Consolidado." && (
                              <span style={{ color: '#90A4AE', fontSize: '11px', display: 'flex', alignItems: 'center', margin: 0, fontWeight: 'normal' }}>
                                  {bgLoading && <span className="footer-spinner" style={{ marginRight: '5px', width: '10px', height: '10px', borderWidth: '2px', borderColor: 'rgba(144, 164, 174, 0.2)', borderTopColor: '#90A4AE' }}></span>}
                                  {statusText}
                              </span>
                          )}
                      </div>
                  </div>

                  {/* COLUNA DE ÍCONES (Empilhados) */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                      {/* Info em cima */}
                      <button className="about-icon-btn" onClick={() => setShowAbout(true)} title="Sobre o Sistema" style={{ margin: 0, padding: 0 }}>
                          <Info size={14} />
                      </button>
                      
                      {/* Lógica Dinâmica dos Ícones do Rodapé */}
                      {(() => {
                          const txtSync = (syncProgressText || "").toLowerCase();
                          const txtStatus = (statusText || "").toLowerCase();
                          
                          // 1. Verifica se está trabalhando ativamente com a Nuvem
                          const isWorking = bgLoading || 
                              (txtSync !== "" && !txtSync.includes("falha") && !txtSync.includes("offline") && !txtSync.includes("100% sincronizado") && !txtSync.includes("atualizado")) || 
                              txtStatus.includes("nuvem") || txtStatus.includes("servidor") || txtStatus.includes("atualizando estatísticas");

                          // 2. NOVO: Verifica se a mensagem atual é de sucesso/conclusão do Banco Local
                          const isLocalReady = txtStatus.includes("pronto") || txtStatus.includes("cache") || txtStatus.includes("restaurada") || txtStatus.includes("atualizada");

                          if (isWorking) {
                              return (
                                  <div title="Trabalhando em segundo plano (Nuvem)..." className="network-active" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default' }}>
                                      <Cloud size={14} />
                                  </div>
                              );
                          }

                          // MÁGICA: Mostra o HD enquant a mensagem de conclusão estiver na tela
                          if (isLocalReady) {
                              return (
                                  <div title="Dados carregados do disco local" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#00E5FF', cursor: 'default' }}>
                                      <HardDrive size={14} />
                                  </div>
                              );
                          }

                          // 3. Padrão: Quando não tem mensagem nenhuma, mostra o botão de Atualizar
                          return (
                              <div 
                                  title={hasSyncFailed ? "Falha na sincronização. Clique para tentar novamente." : "Verificar novas atualizações na Nuvem"}
                                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#546E7A', transition: 'all 0.2s ease', opacity: 1 }}
                                  onClick={() => handleManualSync('manual')}
                                  onMouseOver={(e) => { e.currentTarget.style.color = '#FFD740'; }}
                                  onMouseOut={(e) => { e.currentTarget.style.color = '#546E7A'; }}
                              >
                                  <RefreshCw size={14} />
                              </div>
                          );
                      })()}
                  </div>
              </div>
          </div>
            </footer>
      </div>
      )}
    </>
  );
}

export default App;