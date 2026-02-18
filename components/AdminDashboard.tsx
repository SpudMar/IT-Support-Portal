
import React, { useState, useEffect, useCallback } from 'react';
import {
  TicketStatus, Criticality, IssueCategory, Message,
  AdminTicket, AdminAnalytics, RoutingRule, AdminNote, KBSuggestion,
} from '../types';
import { apiService, getAuthHeaders } from '../services/apiService';
import { useToast } from './ui/Toast';
import {
  Search, Database, Phone, Zap, Filter, ExternalLink, Loader2,
  BookOpen, X, ChevronLeft, ChevronRight, BarChart3, PieChart as PieChartIcon,
  TrendingUp, Clock, AlertTriangle, CheckCircle, MessageSquare,
  Send, Settings, LayoutDashboard, Ticket as TicketIcon, Activity,
  RefreshCw, Plus, Save, Edit3, Mail, PhoneCall, Bell, BellOff,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, LineChart, Line,
} from 'recharts';

// ── Colour palette matching Tailwind config ──
const COLORS = {
  primary_1: '#2E6B77',
  primary_2: '#9F175C',
  primary_3: '#4AA39C',
  primary_4: '#01AD5E',
  teal_accent: '#00808D',
  teal_deep: '#006D79',
  pale_grey: '#F8F9FA',
};

const CHART_COLORS = [
  COLORS.primary_1, COLORS.primary_3, COLORS.primary_4,
  COLORS.primary_2, COLORS.teal_accent, COLORS.teal_deep,
  '#6366f1', '#f59e0b', '#ef4444',
];

const STATUS_OPTIONS = Object.values(TicketStatus);
const CRITICALITY_OPTIONS = Object.values(Criticality);
const CATEGORY_OPTIONS: IssueCategory[] = [
  'Microsoft 365', 'Identity & Access', 'Xero', 'Careview',
  'enableHR', 'Hardware', 'Network & Connectivity', 'Security', 'General',
];

type AdminTab = 'dashboard' | 'tickets' | 'analytics' | 'routing';

const sharepointListUrl = "https://lotusassist.sharepoint.com/sites/Managment/Lists/IT Incidents/AllItems.aspx";

// ── Helper Components ──

const Spinner: React.FC<{ size?: number }> = ({ size = 16 }) => (
  <Loader2 size={size} className="animate-spin text-primary_3" />
);

const EmptyState: React.FC<{ message: string; icon?: React.ReactNode }> = ({ message, icon }) => (
  <div className="flex flex-col items-center justify-center py-16 text-gray-400">
    {icon || <Database size={40} className="mb-3 opacity-40" />}
    <p className="text-sm font-medium mt-2">{message}</p>
  </div>
);

const SkeletonRow: React.FC = () => (
  <tr className="animate-pulse">
    {Array.from({ length: 8 }).map((_, i) => (
      <td key={i} className="px-4 py-4">
        <div className="h-4 bg-gray-200 rounded w-3/4" />
      </td>
    ))}
  </tr>
);

const Badge: React.FC<{ text: string; variant: 'status' | 'criticality' | 'category' }> = ({ text, variant }) => {
  let cls = 'px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ';
  if (variant === 'criticality') {
    if (text === 'High') cls += 'bg-primary_2/10 text-primary_2';
    else if (text === 'Medium') cls += 'bg-yellow-100 text-yellow-700';
    else cls += 'bg-primary_4/10 text-primary_4';
  } else if (variant === 'status') {
    if (text === 'New') cls += 'bg-blue-100 text-blue-700';
    else if (text === 'IT Contacted') cls += 'bg-primary_3/10 text-primary_3';
    else if (text === 'Courier Dispatched') cls += 'bg-yellow-100 text-yellow-700';
    else cls += 'bg-gray-100 text-gray-500';
  } else {
    cls += 'bg-primary_3/10 text-primary_1';
  }
  return <span className={cls}>{text}</span>;
};

function formatDate(dt: string): string {
  if (!dt) return '--';
  try {
    return new Date(dt).toLocaleDateString('en-AU', {
      day: '2-digit', month: 'short', year: 'numeric',
    });
  } catch {
    return dt;
  }
}

function formatDateTime(dt: string): string {
  if (!dt) return '--';
  try {
    return new Date(dt).toLocaleString('en-AU', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return dt;
  }
}

// ── Main AdminDashboard Component ──

const AdminDashboard: React.FC = () => {
  const { showToast } = useToast();
  const [activeTab, setActiveTab] = useState<AdminTab>('dashboard');

  // Dashboard data
  const [analytics, setAnalytics] = useState<AdminAnalytics | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);

  // Tickets tab data
  const [tickets, setTickets] = useState<AdminTicket[]>([]);
  const [ticketsTotal, setTicketsTotal] = useState(0);
  const [ticketsLoading, setTicketsLoading] = useState(true);
  const [ticketSearch, setTicketSearch] = useState('');
  const [ticketStatusFilter, setTicketStatusFilter] = useState<string>('All');
  const [ticketCategoryFilter, setTicketCategoryFilter] = useState<string>('All');
  const [ticketCriticalityFilter, setTicketCriticalityFilter] = useState<string>('All');
  const [ticketPage, setTicketPage] = useState(0);
  const PAGE_SIZE = 50;

  // Ticket detail panel
  const [selectedTicket, setSelectedTicket] = useState<AdminTicket | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailTab, setDetailTab] = useState<'info' | 'transcript' | 'notes' | 'ai' | 'kb'>('info');

  // Admin notes
  const [noteText, setNoteText] = useState('');
  const [addingNote, setAddingNote] = useState(false);

  // AI chat
  const [aiMessages, setAiMessages] = useState<Message[]>([]);
  const [aiInput, setAiInput] = useState('');
  const [aiLoading, setAiLoading] = useState(false);

  // KB
  const [showKBCreator, setShowKBCreator] = useState(false);
  const [kbSuggestion, setKbSuggestion] = useState<KBSuggestion | null>(null);
  const [isGeneratingKB, setIsGeneratingKB] = useState(false);
  const [isSavingKB, setIsSavingKB] = useState(false);

  // Routing
  const [routingRules, setRoutingRules] = useState<RoutingRule[]>([]);
  const [routingLoading, setRoutingLoading] = useState(true);
  const [editingRouteId, setEditingRouteId] = useState<string | null>(null);
  const [editingRouteData, setEditingRouteData] = useState<Partial<RoutingRule>>({});
  const [savingRoute, setSavingRoute] = useState(false);

  // ── Data Fetching ──

  const loadAnalytics = useCallback(async () => {
    setAnalyticsLoading(true);
    try {
      const data = await apiService.getAnalytics();
      setAnalytics(data);
    } catch (err) {
      showToast('error', 'Failed to load analytics data.');
    } finally {
      setAnalyticsLoading(false);
    }
  }, [showToast]);

  const loadTickets = useCallback(async () => {
    setTicketsLoading(true);
    try {
      const params: { status?: string; category?: string; top?: number; skip?: number } = {
        top: PAGE_SIZE,
        skip: ticketPage * PAGE_SIZE,
      };
      if (ticketStatusFilter !== 'All') params.status = ticketStatusFilter;
      if (ticketCategoryFilter !== 'All') params.category = ticketCategoryFilter;

      const data = await apiService.getAdminTickets(params);
      setTickets(data.tickets);
      setTicketsTotal(data.total);
    } catch (err) {
      showToast('error', 'Failed to load tickets.');
    } finally {
      setTicketsLoading(false);
    }
  }, [ticketStatusFilter, ticketCategoryFilter, ticketPage, showToast]);

  const loadRouting = useCallback(async () => {
    setRoutingLoading(true);
    try {
      const data = await apiService.getRouting();
      setRoutingRules(data);
    } catch (err) {
      showToast('error', 'Failed to load routing rules.');
    } finally {
      setRoutingLoading(false);
    }
  }, [showToast]);

  const openTicketDetail = useCallback(async (ticket: AdminTicket) => {
    setSelectedTicket(ticket);
    setDetailTab('info');
    setAiMessages([]);
    setNoteText('');
    setDetailLoading(true);
    try {
      const full = await apiService.getAdminTicket(ticket.sharepointId);
      setSelectedTicket(full);
    } catch (err) {
      showToast('error', 'Failed to load ticket details.');
    } finally {
      setDetailLoading(false);
    }
  }, [showToast]);

  // Initial load based on tab
  useEffect(() => {
    if (activeTab === 'dashboard' || activeTab === 'analytics') {
      loadAnalytics();
    }
  }, [activeTab, loadAnalytics]);

  useEffect(() => {
    if (activeTab === 'tickets') {
      loadTickets();
    }
  }, [activeTab, loadTickets]);

  useEffect(() => {
    if (activeTab === 'routing') {
      loadRouting();
    }
  }, [activeTab, loadRouting]);

  // ── Ticket Actions ──

  const handleStatusChange = async (ticketId: string, newStatus: TicketStatus) => {
    try {
      await apiService.updateAdminTicket(ticketId, { status: newStatus });
      showToast('success', `Status updated to "${newStatus}".`);
      setTickets(prev => prev.map(t =>
        t.sharepointId === ticketId ? { ...t, status: newStatus } : t
      ));
      if (selectedTicket?.sharepointId === ticketId) {
        setSelectedTicket(prev => prev ? { ...prev, status: newStatus } : null);
      }
    } catch (err) {
      showToast('error', 'Failed to update ticket status.');
    }
  };

  const handleAddNote = async () => {
    if (!selectedTicket || !noteText.trim()) return;
    setAddingNote(true);
    try {
      const newNote = await apiService.addAdminNote(
        selectedTicket.sharepointId, noteText.trim(), 'Admin'
      );
      setSelectedTicket(prev => {
        if (!prev) return null;
        return {
          ...prev,
          adminNotes: [...(prev.adminNotes || []), newNote],
        };
      });
      setNoteText('');
      showToast('success', 'Note added successfully.');
    } catch (err) {
      showToast('error', 'Failed to add note.');
    } finally {
      setAddingNote(false);
    }
  };

  // ── AI Architect Chat ──

  const handleAiChat = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!aiInput.trim() || !selectedTicket) return;
    const userMsg: Message = { role: 'user', content: aiInput };
    setAiMessages(prev => [...prev, userMsg]);
    setAiInput('');
    setAiLoading(true);
    try {
      const ticketCtx = {
        id: selectedTicket.sharepointId,
        category: selectedTicket.category,
        summary: selectedTicket.summary,
        criticality: selectedTicket.criticality,
        sharepointId: selectedTicket.sharepointId,
      };
      const allMsgs = [...aiMessages, userMsg].map(m => ({
        role: m.role === 'user' ? 'user' : 'model',
        content: m.content,
      }));
      const result = await apiService.chatWithAdmin(ticketCtx, allMsgs);
      if (result.text) {
        setAiMessages(prev => [...prev, { role: 'model', content: result.text }]);
      }
      if (result.error) {
        showToast('error', `AI error: ${result.error}`);
      }
    } catch (err) {
      showToast('error', 'Failed to get AI response.');
    } finally {
      setAiLoading(false);
    }
  };

  // ── KB Generation ──

  const handleGenerateKB = async () => {
    if (!selectedTicket) return;
    setIsGeneratingKB(true);
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch('/api/kb/generate', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          summary: selectedTicket.summary,
          transcript: selectedTicket.transcript,
          category: selectedTicket.category,
        }),
      });
      const data = await resp.json();
      setKbSuggestion(data.suggestion);
      setShowKBCreator(true);
    } catch (err) {
      showToast('error', 'Failed to generate KB article.');
    } finally {
      setIsGeneratingKB(false);
    }
  };

  const handleSaveKB = async () => {
    if (!kbSuggestion) return;
    setIsSavingKB(true);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch('/api/kb/create', {
        method: 'POST',
        headers,
        body: JSON.stringify(kbSuggestion),
      });
      if (response.ok) {
        setShowKBCreator(false);
        setKbSuggestion(null);
        showToast('success', 'Knowledge Base article created successfully.');
      } else {
        showToast('error', 'Failed to save KB article.');
      }
    } catch (err) {
      showToast('error', 'Failed to save KB article.');
    } finally {
      setIsSavingKB(false);
    }
  };

  // ── Routing Actions ──

  const startEditRoute = (rule: RoutingRule) => {
    setEditingRouteId(rule.id);
    setEditingRouteData({
      adminEmail: rule.adminEmail,
      adminPhone: rule.adminPhone,
      notifySms: rule.notifySms,
    });
  };

  const handleSaveRoute = async () => {
    if (!editingRouteId) return;
    setSavingRoute(true);
    try {
      await apiService.updateRouting(editingRouteId, editingRouteData);
      showToast('success', 'Routing rule updated.');
      setEditingRouteId(null);
      loadRouting();
    } catch (err) {
      showToast('error', 'Failed to update routing rule.');
    } finally {
      setSavingRoute(false);
    }
  };

  // ── Client-side search filter for tickets ──
  const filteredTickets = tickets.filter(t => {
    if (!ticketSearch.trim()) return true;
    const q = ticketSearch.toLowerCase();
    return (
      t.summary.toLowerCase().includes(q) ||
      t.userName.toLowerCase().includes(q) ||
      t.userEmail.toLowerCase().includes(q) ||
      t.sharepointId.toLowerCase().includes(q)
    );
  }).filter(t => {
    if (ticketCriticalityFilter === 'All') return true;
    return t.criticality === ticketCriticalityFilter;
  });

  // ── Tab Navigation ──

  const tabs: { id: AdminTab; label: string; icon: React.ReactNode }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard size={16} /> },
    { id: 'tickets', label: 'Tickets', icon: <TicketIcon size={16} /> },
    { id: 'analytics', label: 'Analytics', icon: <Activity size={16} /> },
    { id: 'routing', label: 'Routing', icon: <Settings size={16} /> },
  ];

  return (
    <div className="space-y-6 max-w-full">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold text-primary_1">Incident Command Center</h1>
          <p className="text-gray-500 text-sm mt-1 uppercase tracking-widest font-bold">Lotus Management Portal</p>
        </div>
        <button
          onClick={() => window.open(sharepointListUrl, '_blank')}
          className="flex items-center gap-2 px-5 py-2.5 bg-primary_1 text-white rounded-xl text-xs font-bold uppercase tracking-widest shadow-lg shadow-primary_1/20 transition-transform hover:scale-105 active:scale-95"
        >
          <Database size={14} /> Open SharePoint List <ExternalLink size={12} />
        </button>
      </div>

      {/* Tab Bar */}
      <div className="flex gap-1 bg-white rounded-2xl p-1.5 shadow-sm border border-gray-100">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-bold uppercase tracking-widest transition-all ${
              activeTab === tab.id
                ? 'bg-primary_1 text-white shadow-md'
                : 'text-gray-500 hover:text-primary_1 hover:bg-pale_grey'
            }`}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="relative flex gap-0">
        {/* Main Content Area */}
        <div className={`flex-1 transition-all duration-300 ${selectedTicket ? 'mr-[50%]' : ''}`} style={selectedTicket ? { maxWidth: '50%' } : {}}>

          {/* Dashboard Tab */}
          {activeTab === 'dashboard' && (
            <div className="space-y-6">
              {analyticsLoading ? (
                <div className="flex items-center justify-center py-20">
                  <Spinner size={28} />
                  <span className="ml-3 text-sm text-gray-500">Loading dashboard...</span>
                </div>
              ) : analytics ? (
                <>
                  {/* KPI Cards */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    <div className="bg-primary_1 text-white p-6 rounded-2xl shadow-lg">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-[10px] font-bold uppercase tracking-widest opacity-70">Total Tickets</p>
                          <p className="text-4xl font-display font-bold mt-1">{analytics.total_tickets}</p>
                        </div>
                        <Database size={28} className="opacity-40" />
                      </div>
                    </div>
                    <div className="bg-primary_2 text-white p-6 rounded-2xl shadow-lg">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-[10px] font-bold uppercase tracking-widest opacity-70">Open Tickets</p>
                          <p className="text-4xl font-display font-bold mt-1">{analytics.open_tickets}</p>
                        </div>
                        <AlertTriangle size={28} className="opacity-40" />
                      </div>
                    </div>
                    <div className="bg-primary_3 text-white p-6 rounded-2xl shadow-lg">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-[10px] font-bold uppercase tracking-widest opacity-70">Tickets Today</p>
                          <p className="text-4xl font-display font-bold mt-1">{analytics.tickets_today}</p>
                        </div>
                        <Clock size={28} className="opacity-40" />
                      </div>
                    </div>
                    <div className="bg-primary_4 text-white p-6 rounded-2xl shadow-lg">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-[10px] font-bold uppercase tracking-widest opacity-70">SLA Compliance</p>
                          <p className="text-4xl font-display font-bold mt-1">94%</p>
                        </div>
                        <CheckCircle size={28} className="opacity-40" />
                      </div>
                    </div>
                  </div>

                  {/* Charts Row */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* Bar Chart - By Category */}
                    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
                      <h3 className="text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-4 flex items-center gap-2">
                        <BarChart3 size={14} /> Tickets by Category
                      </h3>
                      {Object.keys(analytics.by_category).length > 0 ? (
                        <ResponsiveContainer width="100%" height={280}>
                          <BarChart data={Object.entries(analytics.by_category).map(([name, value]) => ({ name, value }))}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                            <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-25} textAnchor="end" height={60} />
                            <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                            <Tooltip />
                            <Bar dataKey="value" fill={COLORS.primary_3} radius={[6, 6, 0, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      ) : (
                        <EmptyState message="No category data available" />
                      )}
                    </div>

                    {/* Pie Chart - By Status */}
                    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
                      <h3 className="text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-4 flex items-center gap-2">
                        <PieChartIcon size={14} /> Tickets by Status
                      </h3>
                      {Object.keys(analytics.by_status).length > 0 ? (
                        <ResponsiveContainer width="100%" height={280}>
                          <PieChart>
                            <Pie
                              data={Object.entries(analytics.by_status).map(([name, value]) => ({ name, value }))}
                              cx="50%" cy="50%"
                              innerRadius={60} outerRadius={100}
                              paddingAngle={3}
                              dataKey="value"
                              label={({ name, value }: { name: string; value: number }) => `${name}: ${value}`}
                              labelLine={false}
                            >
                              {Object.entries(analytics.by_status).map((_, i) => (
                                <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                              ))}
                            </Pie>
                            <Tooltip />
                            <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
                          </PieChart>
                        </ResponsiveContainer>
                      ) : (
                        <EmptyState message="No status data available" />
                      )}
                    </div>
                  </div>

                  {/* Recent Tickets Mini-Table */}
                  <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                    <div className="p-4 border-b bg-pale_grey/30 flex items-center justify-between">
                      <h3 className="text-[11px] font-bold uppercase tracking-widest text-gray-400 flex items-center gap-2">
                        <Clock size={14} /> Recent Tickets
                      </h3>
                      <button
                        onClick={() => setActiveTab('tickets')}
                        className="text-[10px] font-bold text-primary_3 uppercase tracking-widest hover:text-teal_accent transition-colors"
                      >
                        View All
                      </button>
                    </div>
                    <table className="w-full text-left">
                      <thead className="bg-pale_grey/50 text-[10px] font-bold text-gray-400 uppercase tracking-[0.15em]">
                        <tr>
                          <th className="px-4 py-3">ID</th>
                          <th className="px-4 py-3">Summary</th>
                          <th className="px-4 py-3">Staff</th>
                          <th className="px-4 py-3">Status</th>
                          <th className="px-4 py-3">Created</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {analytics.recent_tickets.map(t => (
                          <tr key={t.sharepointId} className="hover:bg-primary_3/5 cursor-pointer text-sm"
                            onClick={() => { setActiveTab('tickets'); openTicketDetail(t as AdminTicket); }}>
                            <td className="px-4 py-3 text-[10px] font-bold text-gray-400">#{t.sharepointId}</td>
                            <td className="px-4 py-3 font-medium text-primary_1 truncate max-w-[250px]">{t.summary}</td>
                            <td className="px-4 py-3 text-gray-600">{t.userName}</td>
                            <td className="px-4 py-3"><Badge text={t.status} variant="status" /></td>
                            <td className="px-4 py-3 text-gray-400 text-xs">{formatDate(t.createdDateTime)}</td>
                          </tr>
                        ))}
                        {analytics.recent_tickets.length === 0 && (
                          <tr><td colSpan={5}><EmptyState message="No recent tickets" /></td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <EmptyState message="Unable to load dashboard data. Please try again." />
              )}
            </div>
          )}

          {/* Tickets Tab */}
          {activeTab === 'tickets' && (
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
              {/* Filters Bar */}
              <div className="p-4 border-b flex flex-wrap gap-3 bg-pale_grey/20 items-center">
                <div className="relative flex-1 min-w-[220px]">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                  <input
                    type="text"
                    placeholder="Search summary, staff name, email..."
                    className="w-full pl-10 pr-4 py-2.5 rounded-xl border-none outline-none text-sm bg-white shadow-sm focus:ring-2 focus:ring-primary_3"
                    value={ticketSearch}
                    onChange={(e) => setTicketSearch(e.target.value)}
                  />
                </div>
                <div className="flex items-center gap-1.5 bg-white px-3 py-1 rounded-xl shadow-sm border">
                  <Filter size={12} className="text-gray-400" />
                  <select
                    value={ticketStatusFilter}
                    onChange={(e) => { setTicketStatusFilter(e.target.value); setTicketPage(0); }}
                    className="py-2 bg-transparent text-[10px] font-bold uppercase tracking-widest outline-none border-none cursor-pointer"
                  >
                    <option value="All">All Statuses</option>
                    {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div className="flex items-center gap-1.5 bg-white px-3 py-1 rounded-xl shadow-sm border">
                  <Filter size={12} className="text-gray-400" />
                  <select
                    value={ticketCategoryFilter}
                    onChange={(e) => { setTicketCategoryFilter(e.target.value); setTicketPage(0); }}
                    className="py-2 bg-transparent text-[10px] font-bold uppercase tracking-widest outline-none border-none cursor-pointer"
                  >
                    <option value="All">All Categories</option>
                    {CATEGORY_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="flex items-center gap-1.5 bg-white px-3 py-1 rounded-xl shadow-sm border">
                  <Filter size={12} className="text-gray-400" />
                  <select
                    value={ticketCriticalityFilter}
                    onChange={(e) => setTicketCriticalityFilter(e.target.value)}
                    className="py-2 bg-transparent text-[10px] font-bold uppercase tracking-widest outline-none border-none cursor-pointer"
                  >
                    <option value="All">All Criticality</option>
                    {CRITICALITY_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <button
                  onClick={loadTickets}
                  className="p-2.5 bg-white rounded-xl shadow-sm border hover:bg-pale_grey transition-colors"
                  title="Refresh tickets"
                >
                  <RefreshCw size={14} className={ticketsLoading ? 'animate-spin text-primary_3' : 'text-gray-400'} />
                </button>
              </div>

              {/* Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead className="bg-pale_grey/50 text-[10px] font-bold text-gray-400 uppercase tracking-[0.15em]">
                    <tr>
                      <th className="px-4 py-3">ID</th>
                      <th className="px-4 py-3">Category</th>
                      <th className="px-4 py-3">Staff</th>
                      <th className="px-4 py-3">Summary</th>
                      <th className="px-4 py-3">Criticality</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Created</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {ticketsLoading ? (
                      Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} />)
                    ) : filteredTickets.length > 0 ? (
                      filteredTickets.map(ticket => (
                        <tr
                          key={ticket.sharepointId}
                          className={`hover:bg-primary_3/5 cursor-pointer group transition-colors ${
                            selectedTicket?.sharepointId === ticket.sharepointId ? 'bg-primary_3/10' : ''
                          }`}
                          onClick={() => openTicketDetail(ticket)}
                        >
                          <td className="px-4 py-3 text-[10px] font-bold text-gray-400">#{ticket.sharepointId}</td>
                          <td className="px-4 py-3"><Badge text={ticket.category || 'General'} variant="category" /></td>
                          <td className="px-4 py-3">
                            <div className="font-bold text-sm text-primary_1">{ticket.userName}</div>
                            <div className="text-[10px] text-gray-400 truncate max-w-[140px]">{ticket.userEmail}</div>
                          </td>
                          <td className="px-4 py-3 text-sm text-primary_1 font-medium max-w-[250px] truncate">{ticket.summary}</td>
                          <td className="px-4 py-3"><Badge text={ticket.criticality || 'Medium'} variant="criticality" /></td>
                          <td className="px-4 py-3">
                            <select
                              value={ticket.status}
                              onChange={(e) => {
                                e.stopPropagation();
                                handleStatusChange(ticket.sharepointId, e.target.value as TicketStatus);
                              }}
                              onClick={(e) => e.stopPropagation()}
                              className="text-[10px] font-bold uppercase tracking-wider bg-transparent border border-gray-200 rounded-lg px-2 py-1 cursor-pointer outline-none focus:border-primary_3"
                            >
                              {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                            </select>
                          </td>
                          <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">{formatDate(ticket.createdDateTime)}</td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  window.open(`${sharepointListUrl.replace('AllItems.aspx', '')}DispForm.aspx?ID=${encodeURIComponent(ticket.sharepointId)}`, '_blank');
                                }}
                                className="p-1.5 text-primary_3 hover:bg-primary_3/10 rounded-lg transition-all"
                                title="Open in SharePoint"
                              >
                                <ExternalLink size={14} />
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  window.open(`msteams://chat/0/0?users=${encodeURIComponent(ticket.userEmail)}`, '_blank');
                                }}
                                className="p-1.5 text-primary_1 hover:bg-primary_1/10 rounded-lg transition-all"
                                title="Contact via Teams"
                              >
                                <MessageSquare size={14} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={8}>
                          <EmptyState message="No tickets match your filters." />
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {!ticketsLoading && filteredTickets.length > 0 && (
                <div className="p-4 border-t flex items-center justify-between bg-pale_grey/20">
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">
                    Showing {ticketPage * PAGE_SIZE + 1} - {ticketPage * PAGE_SIZE + filteredTickets.length} of {ticketsTotal}
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setTicketPage(p => Math.max(0, p - 1))}
                      disabled={ticketPage === 0}
                      className="p-2 bg-white rounded-lg border shadow-sm disabled:opacity-30 hover:bg-pale_grey transition-colors"
                    >
                      <ChevronLeft size={14} />
                    </button>
                    <button
                      onClick={() => setTicketPage(p => p + 1)}
                      disabled={filteredTickets.length < PAGE_SIZE}
                      className="p-2 bg-white rounded-lg border shadow-sm disabled:opacity-30 hover:bg-pale_grey transition-colors"
                    >
                      <ChevronRight size={14} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Analytics Tab */}
          {activeTab === 'analytics' && (
            <div className="space-y-6">
              {analyticsLoading ? (
                <div className="flex items-center justify-center py-20">
                  <Spinner size={28} />
                  <span className="ml-3 text-sm text-gray-500">Loading analytics...</span>
                </div>
              ) : analytics ? (
                <>
                  {/* Line Chart - Tickets Over Time */}
                  <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
                    <h3 className="text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-4 flex items-center gap-2">
                      <TrendingUp size={14} /> Tickets Over Time (Last 30 Days)
                    </h3>
                    {analytics.tickets_by_day && analytics.tickets_by_day.length > 0 ? (
                      <ResponsiveContainer width="100%" height={300}>
                        <LineChart data={analytics.tickets_by_day}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                          <XAxis
                            dataKey="date"
                            tick={{ fontSize: 9 }}
                            tickFormatter={(v: string) => v.slice(5)}
                            angle={-30}
                            textAnchor="end"
                            height={50}
                          />
                          <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                          <Tooltip labelFormatter={(label: string) => `Date: ${label}`} />
                          <Line
                            type="monotone"
                            dataKey="count"
                            stroke={COLORS.primary_3}
                            strokeWidth={2}
                            dot={{ fill: COLORS.primary_3, r: 3 }}
                            activeDot={{ r: 5 }}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    ) : (
                      <EmptyState message="No time-series data available" />
                    )}
                  </div>

                  {/* Two Column Charts */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* Bar Chart - By Category */}
                    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
                      <h3 className="text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-4 flex items-center gap-2">
                        <BarChart3 size={14} /> Tickets by Category
                      </h3>
                      {Object.keys(analytics.by_category).length > 0 ? (
                        <ResponsiveContainer width="100%" height={300}>
                          <BarChart data={Object.entries(analytics.by_category).map(([name, value]) => ({ name, value }))}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                            <XAxis dataKey="name" tick={{ fontSize: 9 }} angle={-30} textAnchor="end" height={70} />
                            <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                            <Tooltip />
                            <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                              {Object.entries(analytics.by_category).map((_, i) => (
                                <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      ) : (
                        <EmptyState message="No category data available" />
                      )}
                    </div>

                    {/* Pie Chart - Criticality Distribution */}
                    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
                      <h3 className="text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-4 flex items-center gap-2">
                        <AlertTriangle size={14} /> Criticality Distribution
                      </h3>
                      {Object.keys(analytics.by_criticality).length > 0 ? (
                        <ResponsiveContainer width="100%" height={300}>
                          <PieChart>
                            <Pie
                              data={Object.entries(analytics.by_criticality).map(([name, value]) => ({ name, value }))}
                              cx="50%" cy="50%"
                              innerRadius={55} outerRadius={95}
                              paddingAngle={3}
                              dataKey="value"
                            >
                              {Object.entries(analytics.by_criticality).map(([key], i) => {
                                let color = COLORS.primary_3;
                                if (key === 'High') color = COLORS.primary_2;
                                else if (key === 'Medium') color = '#f59e0b';
                                else color = COLORS.primary_4;
                                return <Cell key={i} fill={color} />;
                              })}
                            </Pie>
                            <Tooltip />
                            <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
                          </PieChart>
                        </ResponsiveContainer>
                      ) : (
                        <EmptyState message="No criticality data available" />
                      )}
                    </div>
                  </div>

                  {/* Status Distribution Pie */}
                  <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 max-w-lg mx-auto">
                    <h3 className="text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-4 flex items-center gap-2">
                      <PieChartIcon size={14} /> Status Distribution
                    </h3>
                    {Object.keys(analytics.by_status).length > 0 ? (
                      <ResponsiveContainer width="100%" height={280}>
                        <PieChart>
                          <Pie
                            data={Object.entries(analytics.by_status).map(([name, value]) => ({ name, value }))}
                            cx="50%" cy="50%"
                            innerRadius={50} outerRadius={90}
                            paddingAngle={3}
                            dataKey="value"
                          >
                            {Object.entries(analytics.by_status).map((_, i) => (
                              <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                            ))}
                          </Pie>
                          <Tooltip />
                          <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
                        </PieChart>
                      </ResponsiveContainer>
                    ) : (
                      <EmptyState message="No status data available" />
                    )}
                  </div>
                </>
              ) : (
                <EmptyState message="Unable to load analytics data." />
              )}
            </div>
          )}

          {/* Routing Tab */}
          {activeTab === 'routing' && (
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="p-4 border-b bg-pale_grey/20 flex items-center justify-between">
                <h3 className="text-[11px] font-bold uppercase tracking-widest text-gray-400 flex items-center gap-2">
                  <Settings size={14} /> Admin Routing Rules
                </h3>
                <button
                  onClick={loadRouting}
                  className="p-2 bg-white rounded-lg border shadow-sm hover:bg-pale_grey transition-colors"
                  title="Refresh routing"
                >
                  <RefreshCw size={14} className={routingLoading ? 'animate-spin text-primary_3' : 'text-gray-400'} />
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead className="bg-pale_grey/50 text-[10px] font-bold text-gray-400 uppercase tracking-[0.15em]">
                    <tr>
                      <th className="px-6 py-3">Category</th>
                      <th className="px-6 py-3">Admin Email</th>
                      <th className="px-6 py-3">Admin Phone</th>
                      <th className="px-6 py-3">SMS Notifications</th>
                      <th className="px-6 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {routingLoading ? (
                      Array.from({ length: 3 }).map((_, i) => (
                        <tr key={i} className="animate-pulse">
                          {Array.from({ length: 5 }).map((_, j) => (
                            <td key={j} className="px-6 py-4"><div className="h-4 bg-gray-200 rounded w-3/4" /></td>
                          ))}
                        </tr>
                      ))
                    ) : routingRules.length > 0 ? (
                      routingRules.map(rule => (
                        <tr key={rule.id} className="hover:bg-primary_3/5">
                          <td className="px-6 py-4">
                            <Badge text={rule.category || 'General'} variant="category" />
                          </td>
                          <td className="px-6 py-4">
                            {editingRouteId === rule.id ? (
                              <input
                                type="email"
                                value={editingRouteData.adminEmail || ''}
                                onChange={(e) => setEditingRouteData(d => ({ ...d, adminEmail: e.target.value }))}
                                className="w-full px-3 py-1.5 border rounded-lg text-sm outline-none focus:ring-2 focus:ring-primary_3"
                              />
                            ) : (
                              <div className="flex items-center gap-1.5 text-sm text-primary_1">
                                <Mail size={12} className="text-gray-400" /> {rule.adminEmail || '--'}
                              </div>
                            )}
                          </td>
                          <td className="px-6 py-4">
                            {editingRouteId === rule.id ? (
                              <input
                                type="text"
                                value={editingRouteData.adminPhone || ''}
                                onChange={(e) => setEditingRouteData(d => ({ ...d, adminPhone: e.target.value }))}
                                className="w-full px-3 py-1.5 border rounded-lg text-sm outline-none focus:ring-2 focus:ring-primary_3"
                              />
                            ) : (
                              <div className="flex items-center gap-1.5 text-sm text-gray-600">
                                <PhoneCall size={12} className="text-gray-400" /> {rule.adminPhone || '--'}
                              </div>
                            )}
                          </td>
                          <td className="px-6 py-4">
                            {editingRouteId === rule.id ? (
                              <button
                                onClick={() => setEditingRouteData(d => ({ ...d, notifySms: !d.notifySms }))}
                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold uppercase ${
                                  editingRouteData.notifySms
                                    ? 'bg-primary_4/10 text-primary_4'
                                    : 'bg-gray-100 text-gray-400'
                                }`}
                              >
                                {editingRouteData.notifySms ? <Bell size={12} /> : <BellOff size={12} />}
                                {editingRouteData.notifySms ? 'Enabled' : 'Disabled'}
                              </button>
                            ) : (
                              <span className={`flex items-center gap-1.5 text-xs font-bold uppercase ${
                                rule.notifySms ? 'text-primary_4' : 'text-gray-400'
                              }`}>
                                {rule.notifySms ? <Bell size={12} /> : <BellOff size={12} />}
                                {rule.notifySms ? 'Enabled' : 'Disabled'}
                              </span>
                            )}
                          </td>
                          <td className="px-6 py-4 text-right">
                            {editingRouteId === rule.id ? (
                              <div className="flex items-center justify-end gap-2">
                                <button
                                  onClick={handleSaveRoute}
                                  disabled={savingRoute}
                                  className="flex items-center gap-1 px-3 py-1.5 bg-primary_4 text-white rounded-lg text-xs font-bold disabled:opacity-50"
                                >
                                  {savingRoute ? <Spinner size={12} /> : <Save size={12} />} Save
                                </button>
                                <button
                                  onClick={() => setEditingRouteId(null)}
                                  className="px-3 py-1.5 bg-gray-100 text-gray-600 rounded-lg text-xs font-bold"
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => startEditRoute(rule)}
                                className="flex items-center gap-1 px-3 py-1.5 text-primary_3 hover:bg-primary_3/10 rounded-lg text-xs font-bold transition-all"
                              >
                                <Edit3 size={12} /> Edit
                              </button>
                            )}
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={5}>
                          <EmptyState message="No routing rules configured." />
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Ticket Detail Slide-Over Panel */}
        {selectedTicket && (
          <div
            className="fixed top-0 right-0 h-full bg-white shadow-2xl z-[55] border-l border-gray-200 flex flex-col animate-slide-in-panel"
            style={{ width: '50%', minWidth: '480px', maxWidth: '720px' }}
          >
            {/* Panel Header */}
            <div className="bg-primary_1 p-5 text-white flex-shrink-0">
              <div className="flex justify-between items-start">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[9px] font-bold uppercase tracking-widest opacity-60">
                      #{selectedTicket.sharepointId}
                    </span>
                    <Badge text={selectedTicket.criticality || 'Medium'} variant="criticality" />
                  </div>
                  <h2 className="text-lg font-bold leading-tight truncate">{selectedTicket.summary}</h2>
                </div>
                <button
                  onClick={() => setSelectedTicket(null)}
                  className="text-2xl font-light hover:text-primary_3 transition-colors px-2 flex-shrink-0 ml-3"
                  aria-label="Close detail panel"
                >
                  <X size={20} />
                </button>
              </div>
              {/* Status Dropdown in Header */}
              <div className="mt-3">
                <select
                  value={selectedTicket.status}
                  onChange={(e) => handleStatusChange(selectedTicket.sharepointId, e.target.value as TicketStatus)}
                  className="bg-white/20 text-white border border-white/30 rounded-lg px-3 py-1.5 text-xs font-bold uppercase tracking-widest cursor-pointer outline-none"
                >
                  {STATUS_OPTIONS.map(s => <option key={s} value={s} className="text-primary_1">{s}</option>)}
                </select>
              </div>
            </div>

            {/* Detail Sub-tabs */}
            <div className="flex border-b bg-pale_grey/30 flex-shrink-0 overflow-x-auto">
              {(['info', 'transcript', 'notes', 'ai', 'kb'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setDetailTab(tab)}
                  className={`px-4 py-2.5 text-[10px] font-bold uppercase tracking-widest whitespace-nowrap transition-all border-b-2 ${
                    detailTab === tab
                      ? 'border-primary_3 text-primary_1'
                      : 'border-transparent text-gray-400 hover:text-primary_1'
                  }`}
                >
                  {tab === 'info' && 'Details'}
                  {tab === 'transcript' && 'Transcript'}
                  {tab === 'notes' && `Notes${selectedTicket.adminNotes?.length ? ` (${selectedTicket.adminNotes.length})` : ''}`}
                  {tab === 'ai' && 'AI Architect'}
                  {tab === 'kb' && 'KB Article'}
                </button>
              ))}
            </div>

            {/* Detail Content */}
            <div className="flex-1 overflow-y-auto p-5">
              {detailLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Spinner size={24} />
                  <span className="ml-3 text-sm text-gray-500">Loading ticket details...</span>
                </div>
              ) : (
                <>
                  {/* Info Tab */}
                  {detailTab === 'info' && (
                    <div className="space-y-5">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="bg-pale_grey p-3 rounded-xl">
                          <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-0.5">Location</p>
                          <p className="text-sm font-bold text-primary_1">{selectedTicket.location || 'Pending'}</p>
                        </div>
                        <div className="bg-pale_grey p-3 rounded-xl">
                          <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-0.5">Callback Window</p>
                          <p className="text-sm font-bold text-primary_1">{selectedTicket.availability || 'Pending'}</p>
                        </div>
                        <div className="bg-pale_grey p-3 rounded-xl">
                          <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-0.5">Staff Contact</p>
                          <p className="text-sm font-bold text-primary_1">{selectedTicket.userPhone || 'Pending'}</p>
                        </div>
                        <div className="bg-pale_grey p-3 rounded-xl">
                          <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-0.5">Email</p>
                          <p className="text-sm font-bold text-primary_1 truncate">{selectedTicket.userEmail || 'Pending'}</p>
                        </div>
                        <div className="bg-pale_grey p-3 rounded-xl">
                          <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-0.5">Category</p>
                          <p className="text-sm font-bold text-primary_1">{selectedTicket.category || 'General'}</p>
                        </div>
                        <div className="bg-pale_grey p-3 rounded-xl">
                          <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-0.5">Created Date</p>
                          <p className="text-sm font-bold text-primary_1">{formatDate(selectedTicket.createdDateTime)}</p>
                        </div>
                      </div>

                      {/* Thinking Log / AI Reasoning */}
                      {selectedTicket.thinkingLog && (
                        <div className="bg-primary_1/5 p-4 rounded-xl border border-primary_1/10">
                          <h4 className="text-[9px] font-bold text-primary_1 uppercase mb-2 flex items-center gap-1.5">
                            <Zap size={11} className="text-primary_4" /> Agentic Reasoning Path
                          </h4>
                          <p className="text-xs text-primary_1/70 italic leading-relaxed whitespace-pre-wrap">
                            {selectedTicket.thinkingLog}
                          </p>
                        </div>
                      )}

                      {/* Quick Actions */}
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => window.open(
                            `${sharepointListUrl.replace('AllItems.aspx', '')}DispForm.aspx?ID=${encodeURIComponent(selectedTicket.sharepointId)}`,
                            '_blank'
                          )}
                          className="flex items-center gap-1.5 px-4 py-2 bg-primary_3 text-white rounded-xl text-xs font-bold uppercase tracking-widest hover:bg-teal_accent transition-all"
                        >
                          <ExternalLink size={12} /> SharePoint
                        </button>
                        <button
                          onClick={() => window.open(
                            `msteams://chat/0/0?users=${encodeURIComponent(selectedTicket.userEmail)}`,
                            '_blank'
                          )}
                          className="flex items-center gap-1.5 px-4 py-2 bg-primary_1 text-white rounded-xl text-xs font-bold uppercase tracking-widest hover:bg-primary_1/80 transition-all"
                        >
                          <MessageSquare size={12} /> Teams Chat
                        </button>
                        {selectedTicket.userPhone && (
                          <button
                            onClick={() => window.open(`tel:${selectedTicket.userPhone}`, '_self')}
                            className="flex items-center gap-1.5 px-4 py-2 bg-white border border-gray-200 text-primary_1 rounded-xl text-xs font-bold uppercase tracking-widest hover:bg-pale_grey transition-all"
                          >
                            <Phone size={12} /> Call
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Transcript Tab */}
                  {detailTab === 'transcript' && (
                    <div className="space-y-3">
                      {selectedTicket.transcript && selectedTicket.transcript.length > 0 ? (
                        selectedTicket.transcript.map((msg, i) => (
                          <div
                            key={i}
                            className={`p-3 rounded-xl text-sm leading-relaxed ${
                              msg.role === 'user'
                                ? 'bg-primary_1 text-white ml-8'
                                : msg.role === 'system'
                                ? 'bg-yellow-50 text-yellow-800 border border-yellow-200 text-xs italic'
                                : 'bg-pale_grey text-primary_1 mr-8 border border-gray-100'
                            }`}
                          >
                            <div className="text-[9px] font-bold uppercase tracking-widest opacity-60 mb-1">
                              {msg.role === 'user' ? 'Staff' : msg.role === 'system' ? 'System' : 'AI Assistant'}
                            </div>
                            <div className="whitespace-pre-wrap">{msg.content}</div>
                          </div>
                        ))
                      ) : (
                        <EmptyState message="No conversation transcript available." icon={<MessageSquare size={36} className="opacity-30" />} />
                      )}
                    </div>
                  )}

                  {/* Notes Tab */}
                  {detailTab === 'notes' && (
                    <div className="space-y-4">
                      {/* Existing Notes Timeline */}
                      {selectedTicket.adminNotes && selectedTicket.adminNotes.length > 0 ? (
                        <div className="space-y-3">
                          {selectedTicket.adminNotes.map((note, i) => (
                            <div key={i} className="bg-pale_grey p-3 rounded-xl border border-gray-100">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-[10px] font-bold text-primary_1 uppercase tracking-wider">
                                  {note.author}
                                </span>
                                <span className="text-[9px] text-gray-400 font-medium">
                                  {formatDateTime(note.timestamp)}
                                </span>
                              </div>
                              <p className="text-sm text-primary_1/80 leading-relaxed">{note.note}</p>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="text-center py-8 text-gray-400">
                          <p className="text-sm">No admin notes yet.</p>
                        </div>
                      )}

                      {/* Add Note Form */}
                      <div className="border-t pt-4">
                        <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">
                          Add Admin Note
                        </label>
                        <div className="flex gap-2">
                          <textarea
                            value={noteText}
                            onChange={(e) => setNoteText(e.target.value)}
                            placeholder="Type a note..."
                            rows={2}
                            className="flex-1 border border-gray-200 p-3 rounded-xl text-sm outline-none focus:ring-2 focus:ring-primary_3 resize-none"
                          />
                          <button
                            onClick={handleAddNote}
                            disabled={addingNote || !noteText.trim()}
                            className="self-end px-4 py-2 bg-primary_3 text-white rounded-xl text-xs font-bold shadow-md hover:bg-teal_accent transition-all disabled:opacity-50 flex items-center gap-1.5"
                          >
                            {addingNote ? <Spinner size={12} /> : <Plus size={12} />} Add
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* AI Architect Tab */}
                  {detailTab === 'ai' && (
                    <div className="space-y-4">
                      <div className="bg-primary_1/5 p-3 rounded-xl border border-primary_1/10">
                        <h4 className="text-[10px] font-bold text-primary_1 uppercase tracking-widest flex items-center gap-1.5 mb-1">
                          <Zap size={12} className="text-primary_2" /> Senior IT Architect (Gemini Pro)
                        </h4>
                        <p className="text-[10px] text-primary_1/60">
                          Multi-turn consultation about this specific incident. Context is automatically provided.
                        </p>
                      </div>

                      {/* Chat Messages */}
                      <div className="space-y-3 min-h-[120px]">
                        {aiMessages.map((m, i) => (
                          <div
                            key={i}
                            className={`p-3 rounded-xl text-sm leading-relaxed ${
                              m.role === 'user'
                                ? 'bg-primary_1 text-white ml-8'
                                : 'bg-white text-primary_1 mr-8 border shadow-sm'
                            }`}
                          >
                            <div className="whitespace-pre-wrap">{m.content}</div>
                          </div>
                        ))}
                        {aiLoading && (
                          <div className="flex items-center gap-2 text-gray-400 p-3">
                            <Spinner size={14} />
                            <span className="text-[10px] font-bold uppercase tracking-widest">Architect is thinking...</span>
                          </div>
                        )}
                        {aiMessages.length === 0 && !aiLoading && (
                          <div className="text-center py-8 text-gray-400 text-sm">
                            Ask a question about this incident to get expert advice.
                          </div>
                        )}
                      </div>

                      {/* Chat Input */}
                      <form onSubmit={handleAiChat} className="flex gap-2">
                        <input
                          type="text"
                          value={aiInput}
                          onChange={(e) => setAiInput(e.target.value)}
                          placeholder="Ask technical advice for this incident..."
                          className="flex-1 border border-gray-200 p-3 rounded-xl text-sm outline-none focus:ring-2 focus:ring-primary_3"
                        />
                        <button
                          type="submit"
                          disabled={aiLoading || !aiInput.trim()}
                          className="bg-primary_2 text-white px-5 rounded-xl font-bold text-sm shadow-md hover:scale-105 active:scale-95 disabled:opacity-50 transition-transform flex items-center gap-1.5"
                        >
                          <Send size={14} /> Consult
                        </button>
                      </form>
                    </div>
                  )}

                  {/* KB Article Tab */}
                  {detailTab === 'kb' && (
                    <div className="space-y-4">
                      <div className="bg-primary_3/5 p-3 rounded-xl border border-primary_3/10">
                        <h4 className="text-[10px] font-bold text-primary_1 uppercase tracking-widest flex items-center gap-1.5 mb-1">
                          <BookOpen size={12} className="text-primary_3" /> Generate Knowledge Base Article
                        </h4>
                        <p className="text-[10px] text-primary_1/60">
                          Auto-generate a KB article from this ticket's transcript and resolution.
                        </p>
                      </div>

                      <button
                        onClick={handleGenerateKB}
                        disabled={isGeneratingKB}
                        className="w-full bg-primary_3 text-white px-5 py-3 rounded-xl font-bold text-sm uppercase tracking-widest shadow-md hover:bg-teal_accent transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                      >
                        {isGeneratingKB ? (
                          <><Spinner size={14} /> Generating KB Article...</>
                        ) : (
                          <><BookOpen size={14} /> Create Knowledge Base Article</>
                        )}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* KB Creator Modal */}
      {showKBCreator && kbSuggestion && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-primary_1/50 backdrop-blur-lg">
          <div className="bg-white w-full max-w-3xl rounded-[2.5rem] shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="bg-primary_3 p-6 text-white flex justify-between items-center">
              <div className="flex items-center gap-3">
                <BookOpen size={24} />
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-widest opacity-70">AI-Generated Suggestion</span>
                  <h2 className="text-xl font-bold">Review Knowledge Base Article</h2>
                </div>
              </div>
              <button onClick={() => setShowKBCreator(false)} className="text-3xl font-light hover:opacity-70 transition-opacity px-2">
                <X size={24} />
              </button>
            </div>

            <div className="flex-1 p-8 overflow-y-auto space-y-6">
              <div>
                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Title/Question</label>
                <input
                  type="text"
                  value={kbSuggestion.title}
                  onChange={(e) => setKbSuggestion({ ...kbSuggestion, title: e.target.value })}
                  className="w-full p-4 border-2 border-gray-200 rounded-xl outline-none focus:border-primary_3 text-lg font-bold text-primary_1"
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Category</label>
                <select
                  value={kbSuggestion.category}
                  onChange={(e) => setKbSuggestion({ ...kbSuggestion, category: e.target.value })}
                  className="w-full p-4 border-2 border-gray-200 rounded-xl outline-none focus:border-primary_3 font-bold text-primary_1 cursor-pointer"
                >
                  {CATEGORY_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Solution/Answer</label>
                <textarea
                  value={kbSuggestion.answer}
                  onChange={(e) => setKbSuggestion({ ...kbSuggestion, answer: e.target.value })}
                  rows={10}
                  className="w-full p-4 border-2 border-gray-200 rounded-xl outline-none focus:border-primary_3 text-primary_1 leading-relaxed resize-none"
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Keywords (comma-separated)</label>
                <input
                  type="text"
                  value={Array.isArray(kbSuggestion.keywords) ? kbSuggestion.keywords.join(', ') : kbSuggestion.keywords}
                  onChange={(e) => setKbSuggestion({
                    ...kbSuggestion,
                    keywords: e.target.value.split(',').map((k: string) => k.trim()),
                  })}
                  className="w-full p-4 border-2 border-gray-200 rounded-xl outline-none focus:border-primary_3 text-primary_1"
                  placeholder="vpn, connection, remote access"
                />
              </div>
            </div>

            <div className="p-6 bg-pale_grey border-t flex gap-4 justify-end">
              <button
                onClick={() => setShowKBCreator(false)}
                className="px-6 py-3 bg-white border-2 border-gray-200 text-primary_1 font-bold rounded-xl hover:border-gray-300 transition-all"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveKB}
                disabled={isSavingKB}
                className="px-8 py-3 bg-primary_3 text-white font-bold rounded-xl hover:bg-teal_accent transition-all shadow-lg disabled:opacity-50 flex items-center gap-2"
              >
                {isSavingKB ? (
                  <><Spinner size={14} /> Saving...</>
                ) : (
                  <><Save size={14} /> Save to Knowledge Base</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Slide-in animation styles */}
      <style>{`
        @keyframes slideInPanel {
          from {
            transform: translateX(100%);
          }
          to {
            transform: translateX(0);
          }
        }
        .animate-slide-in-panel {
          animation: slideInPanel 0.3s ease-out;
        }
      `}</style>
    </div>
  );
};

export default AdminDashboard;
