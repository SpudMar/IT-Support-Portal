
import React, { useState } from 'react';
import { Ticket, TicketStatus, Message } from '../types';
import { Search, Database, Phone, Zap, Copy, Filter, ExternalLink, Loader2, BookOpen } from 'lucide-react';
import { chatWithAdminExpert, extractText } from '../services/geminiService';

interface AdminDashboardProps {
  tickets: Ticket[];
  onStatusChange: (id: string, status: TicketStatus) => void;
}

const AdminDashboard: React.FC<AdminDashboardProps> = ({ tickets, onStatusChange }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [filter, setFilter] = useState<TicketStatus | 'All'>('All');
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [adminMessages, setAdminMessages] = useState<Message[]>([]);
  const [adminInput, setAdminInput] = useState('');
  const [isAdminChatLoading, setIsAdminChatLoading] = useState(false);
  const [showKBCreator, setShowKBCreator] = useState(false);
  const [kbSuggestion, setKbSuggestion] = useState<any>(null);
  const [isGeneratingKB, setIsGeneratingKB] = useState(false);
  const [isSavingKB, setIsSavingKB] = useState(false);

  const filteredTickets = tickets.filter(t => {
    const matchesSearch = t.summary.toLowerCase().includes(searchTerm.toLowerCase()) ||
      t.userName.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesFilter = filter === 'All' || t.status === filter;
    return matchesSearch && matchesFilter;
  });

  const handleAdminConsult = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!adminInput.trim() || !selectedTicket) return;
    const newMsg: Message = { role: 'user', content: adminInput };
    setAdminMessages(prev => [...prev, newMsg]);
    setAdminInput('');
    setIsAdminChatLoading(true);
    try {
      const response = await chatWithAdminExpert(selectedTicket, [...adminMessages, newMsg]);
      const text = extractText(response);
      if (text) setAdminMessages(prev => [...prev, { role: 'model', content: text }]);
    } finally { setIsAdminChatLoading(false); }
  };

  const handleGenerateKB = async () => {
    if (!selectedTicket) return;
    setIsGeneratingKB(true);
    try {
      const response = await fetch('/api/kb/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: selectedTicket.summary,
          transcript: selectedTicket.transcript,
          category: selectedTicket.category
        })
      });
      const data = await response.json();
      setKbSuggestion(data.suggestion);
      setShowKBCreator(true);
    } catch (error) {
      console.error('KB generation failed:', error);
    } finally {
      setIsGeneratingKB(false);
    }
  };

  const handleSaveKB = async () => {
    if (!kbSuggestion) return;
    setIsSavingKB(true);
    try {
      const response = await fetch('/api/kb/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(kbSuggestion)
      });
      if (response.ok) {
        setShowKBCreator(false);
        setKbSuggestion(null);
        alert('✅ Knowledge Base article created successfully!');
      }
    } catch (error) {
      console.error('KB save failed:', error);
      alert('❌ Failed to save KB article');
    } finally {
      setIsSavingKB(false);
    }
  };

  const sharepointListUrl = "https://lotusassist.sharepoint.com/sites/Managment/Lists/IT Incidents/AllItems.aspx";

  return (
    <div className="space-y-8 max-w-7xl mx-auto">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-display font-bold text-primary_1">Incident Command Center</h1>
          <p className="text-gray-500 text-sm mt-1 uppercase tracking-widest font-bold">Lotus Management Portal Active</p>
        </div>
        <button
          onClick={() => window.open(sharepointListUrl, '_blank')}
          className="flex items-center gap-2 px-5 py-2.5 bg-primary_1 text-white rounded-xl text-xs font-bold uppercase tracking-widest shadow-lg shadow-primary_1/20 transition-transform hover:scale-105 active:scale-95"
        >
          <Database size={14} /> Open SharePoint List <ExternalLink size={12} />
        </button>
      </div>

      <div className="bg-white rounded-[2rem] shadow-xl border border-gray-100 overflow-hidden">
        <div className="p-6 border-b flex flex-wrap gap-4 bg-pale_grey/20">
          <div className="relative flex-1 min-w-[300px]">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
            <input type="text" placeholder="Search incidents..." className="w-full pl-12 pr-4 py-3 rounded-xl border-none outline-none text-sm bg-white shadow-sm" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
          </div>
          <div className="flex items-center gap-2 bg-white px-4 py-1 rounded-xl shadow-sm border">
            <Filter size={14} className="text-gray-400" />
            <select value={filter} onChange={(e) => setFilter(e.target.value as any)} className="py-2 bg-transparent text-xs font-bold uppercase tracking-widest outline-none border-none cursor-pointer">
              <option value="All">All Statuses</option>
              {Object.values(TicketStatus).map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-pale_grey/50 text-[10px] font-bold text-gray-400 uppercase tracking-[0.2em]">
              <tr>
                <th className="px-8 py-5">App</th>
                <th className="px-8 py-5">Staff</th>
                <th className="px-8 py-5">Summary</th>
                <th className="px-8 py-5">Urgency</th>
                <th className="px-8 py-5">Sync</th>
                <th className="px-8 py-5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {filteredTickets.map(ticket => (
                <tr key={ticket.id} className="hover:bg-primary_3/5 cursor-pointer group" onClick={() => setSelectedTicket(ticket)}>
                  <td className="px-8 py-6">
                    <span className="px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider bg-primary_3/10 text-primary_1">
                      {ticket.category || 'General'}
                    </span>
                  </td>
                  <td className="px-8 py-6">
                    <div className="font-bold text-sm text-primary_1">{ticket.userName}</div>
                    <div className="text-[10px] text-gray-400 truncate max-w-[150px]">{ticket.userEmail}</div>
                  </td>
                  <td className="px-8 py-6 text-sm text-primary_1 font-medium">{ticket.summary}</td>
                  <td className="px-8 py-6">
                    <span className={`font-bold text-[10px] uppercase ${ticket.criticality === 'High' ? 'text-primary_2' : 'text-primary_3'}`}>
                      {ticket.criticality}
                    </span>
                  </td>
                  <td className="px-8 py-6">
                    {ticket.sharepointId ? (
                      <span className="text-[9px] font-bold text-primary_4 uppercase flex items-center gap-1">
                        ID: {ticket.sharepointId.substring(0, 8)}...
                      </span>
                    ) : (
                      <span className="text-[9px] font-bold text-gray-300 uppercase">Not Synced</span>
                    )}
                  </td>
                  <td className="px-8 py-6 text-right">
                    <button onClick={(e) => { e.stopPropagation(); window.open(`msteams://chat/0/0?users=${ticket.userEmail}`, '_blank'); }} className="p-2 text-primary_3 hover:bg-primary_3/10 rounded-lg transition-all opacity-0 group-hover:opacity-100" title="Contact via Teams">
                      <Copy size={16} />
                    </button>
                  </td>
                </tr>
              ))}
              {filteredTickets.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-8 py-20 text-center text-gray-400 text-sm font-medium">
                    No active incidents found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selectedTicket && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-primary_1/40 backdrop-blur-md">
          <div className="bg-white w-full max-w-4xl rounded-[2.5rem] shadow-2xl overflow-hidden flex flex-col h-[80vh]">
            <div className="bg-primary_1 p-6 text-white flex justify-between items-center">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-widest opacity-70">Internal ID: {selectedTicket.id}</span>
                <h2 className="text-xl font-bold">{selectedTicket.summary}</h2>
              </div>
              <button onClick={() => setSelectedTicket(null)} className="text-3xl font-light hover:text-primary_3 transition-colors px-2">×</button>
            </div>
            <div className="flex-1 p-8 overflow-y-auto bg-pale_grey/20">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6 text-center">
                <div className="bg-white p-4 rounded-xl border shadow-sm"><p className="text-[10px] font-bold text-gray-400 uppercase tracking-tighter">Current Location</p><p className="font-bold text-primary_1">{selectedTicket.location || 'Pending'}</p></div>
                <div className="bg-white p-4 rounded-xl border shadow-sm"><p className="text-[10px] font-bold text-gray-400 uppercase tracking-tighter">Callback Window</p><p className="font-bold text-primary_1">{selectedTicket.availability || 'Pending'}</p></div>
                <div className="bg-white p-4 rounded-xl border shadow-sm"><p className="text-[10px] font-bold text-gray-400 uppercase tracking-tighter">Staff Contact</p><p className="font-bold text-primary_1">{selectedTicket.userPhone || 'Pending'}</p></div>
              </div>

              <div className="flex items-center gap-4 mb-6">
                <div className="flex-1 bg-white p-4 rounded-xl border shadow-sm">
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-tighter mb-1">Ticket Status</p>
                  <select
                    value={selectedTicket.status}
                    onChange={(e) => onStatusChange(selectedTicket.id, e.target.value as TicketStatus)}
                    className="w-full bg-transparent font-bold text-primary_1 outline-none border-none cursor-pointer"
                  >
                    {Object.values(TicketStatus).map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                {selectedTicket.sharepointId && (
                  <button
                    onClick={() => window.open(`${sharepointListUrl}/DispForm.aspx?ID=${selectedTicket.sharepointId}`, '_blank')}
                    className="px-6 py-4 bg-primary_3 text-white rounded-xl font-bold text-xs uppercase tracking-widest shadow-lg hover:bg-teal_accent transition-all"
                  >
                    View in SharePoint
                  </button>
                )}
              </div>

              <div className="bg-primary_1/5 p-6 rounded-2xl mb-6 border border-primary_1/10 italic text-sm text-primary_1/80">
                <h4 className="text-[10px] font-bold text-primary_1 uppercase mb-2 flex items-center gap-2"><Zap size={12} className="text-primary_4" /> Agentic Reasoning Path</h4>
                {selectedTicket.thinkingLog || "Awaiting further diagnostic telemetry..."}
              </div>

              <div className="border-t pt-6">
                <h4 className="font-display font-bold text-sm mb-4 text-primary_1 flex items-center gap-2">
                  <Zap size={16} className="text-primary_2" /> Consult Senior IT Architect (Gemini Pro)
                </h4>
                <div className="space-y-4 mb-6">
                  {adminMessages.map((m, i) => (
                    <div key={i} className={`p-4 rounded-2xl text-sm leading-relaxed ${m.role === 'user' ? 'bg-primary_1 text-white ml-12' : 'bg-white text-primary_1 mr-12 border shadow-sm'}`}>{m.content}</div>
                  ))}
                  {isAdminChatLoading && (
                    <div className="flex items-center gap-2 text-gray-400 animate-pulse">
                      <div className="w-2 h-2 bg-primary_3 rounded-full"></div>
                      <div className="w-2 h-2 bg-primary_3 rounded-full delay-75"></div>
                      <div className="w-2 h-2 bg-primary_3 rounded-full delay-150"></div>
                      <span className="text-[10px] font-bold uppercase tracking-widest">Architect is thinking...</span>
                    </div>
                  )}
                </div>
                <form onSubmit={handleAdminConsult} className="flex gap-2">
                  <input type="text" value={adminInput} onChange={(e) => setAdminInput(e.target.value)} placeholder="Ask technical advice for this incident..." className="flex-1 border p-4 rounded-xl text-sm outline-none focus:ring-2 focus:ring-primary_3 bg-white" />
                  <button type="submit" disabled={isAdminChatLoading} className="bg-primary_2 text-white px-8 rounded-xl font-bold text-sm shadow-lg shadow-primary_2/20 transition-transform hover:scale-105 active:scale-95 disabled:opacity-50">Consult</button>
                </form>
              </div>

              <div className="border-t pt-6 mt-6">
                <button
                  onClick={handleGenerateKB}
                  disabled={isGeneratingKB}
                  className="w-full bg-primary_3 text-white px-6 py-4 rounded-xl font-bold text-sm uppercase tracking-widest shadow-lg hover:bg-teal_accent transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isGeneratingKB ? (
                    <><Loader2 className="animate-spin" size={16} /> Generating KB Article...</>
                  ) : (
                    <><BookOpen size={16} /> Create Knowledge Base Article</>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

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
              <button onClick={() => setShowKBCreator(false)} className="text-3xl font-light hover:opacity-70 transition-opacity px-2">×</button>
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
                  <option>Microsoft 365</option>
                  <option>Identity & Access</option>
                  <option>Xero</option>
                  <option>Careview</option>
                  <option>enableHR</option>
                  <option>Hardware</option>
                  <option>Network & Connectivity</option>
                  <option>Security</option>
                  <option>General</option>
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
                  onChange={(e) => setKbSuggestion({ ...kbSuggestion, keywords: e.target.value.split(',').map((k: string) => k.trim()) })}
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
                  <><Loader2 className="animate-spin" size={16} /> Saving...</>
                ) : (
                  <>💾 Save to Knowledge Base</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AdminDashboard;
