
import React, { useState, useEffect, useRef } from 'react';
import { useMsal, AuthenticatedTemplate, UnauthenticatedTemplate } from "@azure/msal-react";
import ChatInterface from './components/ChatInterface';
import AdminDashboard from './components/AdminDashboard';
import KnowledgeBaseView from './components/KnowledgeBaseView';
import Login from './components/Login';
import { Ticket, TicketStatus, Criticality } from './types';
import { apiService } from './services/apiService';
import { LayoutDashboard, MessageSquareText, BookOpen, UserCircle, LogOut, CloudCheck, WifiOff, Loader2, History, AlertCircle } from 'lucide-react';

const App: React.FC = () => {
  const [activeView, setActiveView] = useState<'staff' | 'admin' | 'kb'>('staff');
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncFailed, setSyncFailed] = useState(false);
  const [activeTicketId, setActiveTicketId] = useState<string | null>(null);
  const { instance, accounts } = useMsal();
  
  // Ref to prevent multiple simultaneous ticket creations for the same session
  const isCreatingRef = useRef(false);

  const userEmail = accounts[0]?.username;
  const userName = accounts[0]?.name;

  const isAdmin = accounts.length > 0 && (
    accounts[0].username.toLowerCase().includes('admin') || 
    accounts[0].name?.toLowerCase().includes('admin')
  );

  // Initial History Load
  useEffect(() => {
    if (userEmail) {
      setIsSyncing(true);
      apiService.searchTickets(userEmail).then(history => {
        const mappedHistory: Ticket[] = history.map(t => ({
          id: `SP-${t.sharepointId}`,
          sharepointId: t.sharepointId,
          summary: t.summary || 'IT Request',
          userName: userName || 'Staff',
          userEmail: userEmail,
          status: (t.status as TicketStatus) || TicketStatus.NEW,
          category: t.category || 'General',
          criticality: (t.criticality as Criticality) || Criticality.MEDIUM,
          createdAt: t.createdAt || Date.now(),
          adminRequired: false,
          transcript: []
        }));
        setTickets(mappedHistory);
        setIsSyncing(false);
      }).catch(() => {
        setSyncFailed(true);
        setIsSyncing(false);
      });
    }
  }, [userEmail, userName]);

  const handleLogout = () => {
    instance.logoutPopup().catch(e => console.error(e));
  };

  const handleTicketUpdate = async (updateData: Partial<Ticket>) => {
    if (isCreatingRef.current) return;

    setIsSyncing(true);
    setSyncFailed(false);
    
    let targetTicket: Ticket;
    
    setTickets(prev => {
      const existingIdx = prev.findIndex(t => t.id === activeTicketId);
      let newTickets = [...prev];

      if (existingIdx > -1) {
        targetTicket = { ...prev[existingIdx], ...updateData };
        newTickets[existingIdx] = targetTicket;
      } else {
        isCreatingRef.current = true;
        const newId = `LA-${Date.now().toString().slice(-4)}`;
        setActiveTicketId(newId);
        
        targetTicket = {
          id: newId,
          userName: userName || 'Staff',
          userEmail: userEmail || '',
          userPhone: updateData.userPhone,
          summary: updateData.summary || 'Diagnosing Issue...',
          category: updateData.category || 'General',
          transcript: updateData.transcript || [],
          criticality: updateData.criticality || Criticality.MEDIUM,
          adminRequired: updateData.adminRequired || false,
          status: TicketStatus.NEW,
          createdAt: Date.now(),
          location: updateData.location,
          availability: updateData.availability,
          thinkingLog: updateData.thinkingLog,
          ...updateData
        };
        newTickets = [targetTicket, ...prev];
      }

      // Async sync to bridge
      apiService.saveTicket(targetTicket).then(spId => {
        isCreatingRef.current = false;
        setIsSyncing(false);
        if (spId) {
          setTickets(current => current.map(t => t.id === targetTicket.id ? { ...t, sharepointId: spId } : t));
        } else {
          setSyncFailed(true);
        }
      }).catch(() => {
        isCreatingRef.current = false;
        setIsSyncing(false);
        setSyncFailed(true);
      });

      return newTickets;
    });
  };

  const handleStatusChange = async (id: string, status: TicketStatus) => {
    const ticket = tickets.find(t => t.id === id);
    if (!ticket || !ticket.sharepointId) return;

    setIsSyncing(true);
    const success = await apiService.updateStatus(ticket.sharepointId, status);
    setIsSyncing(false);
    
    if (success) {
      setTickets(prev => prev.map(t => t.id === id ? { ...t, status } : t));
    } else {
      setSyncFailed(true);
    }
  };

  return (
    <>
      <UnauthenticatedTemplate>
        <Login />
      </UnauthenticatedTemplate>

      <AuthenticatedTemplate>
        <div className="min-h-screen flex flex-col font-sans bg-pale_grey text-primary_1">
          <header className="bg-primary_1 text-white shadow-xl sticky top-0 z-50">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
              <div className="flex justify-between items-center h-20">
                <div className="flex items-center gap-4">
                  <div className="bg-white p-2 rounded-xl shadow-lg">
                    <MessageSquareText className="text-primary_1 w-6 h-6" />
                  </div>
                  <div>
                    <h1 className="text-xl font-display font-bold tracking-tight">LotUs. <span className="text-primary_3 font-light">assist</span></h1>
                    <div className="flex items-center gap-2 mt-0.5">
                      <div className="flex items-center gap-1.5 px-2 py-0.5 bg-primary_4/20 rounded-full">
                        <div className={`w-1.5 h-1.5 rounded-full ${syncFailed ? 'bg-primary_2' : 'bg-primary_4 animate-pulse'}`}></div>
                        <span className="text-[9px] font-bold uppercase tracking-widest text-primary_4">
                          {syncFailed ? 'Offline Link' : 'Managed Sync'}
                        </span>
                      </div>
                      {isSyncing && (
                         <div className="flex items-center gap-1 text-[9px] text-primary_3 font-bold uppercase">
                           <Loader2 size={10} className="animate-spin" /> Syncing...
                         </div>
                      )}
                    </div>
                  </div>
                </div>

                <nav className="hidden md:flex items-center gap-1">
                  <button onClick={() => setActiveView('staff')} className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-bold transition-all uppercase tracking-widest ${activeView === 'staff' ? 'bg-white/10' : 'text-white/60 hover:text-white'}`}>
                    Staff
                  </button>
                  <button onClick={() => setActiveView('kb')} className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-bold transition-all uppercase tracking-widest ${activeView === 'kb' ? 'bg-white/10' : 'text-white/60 hover:text-white'}`}>
                    Knowledge
                  </button>
                  {isAdmin && (
                    <button onClick={() => setActiveView('admin')} className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-bold transition-all uppercase tracking-widest ${activeView === 'admin' ? 'bg-white/10' : 'text-white/60 hover:text-white'}`}>
                      Admin
                    </button>
                  )}
                </nav>

                <div className="flex items-center gap-3">
                  <div className="hidden lg:block text-right">
                    <p className="text-[9px] font-bold uppercase tracking-tighter text-white/40 leading-none">Employee</p>
                    <p className="text-xs font-bold truncate max-w-[120px]">{userName}</p>
                  </div>
                  <button onClick={handleLogout} className="p-2.5 bg-white/10 hover:bg-primary_2 rounded-lg transition-all">
                    <LogOut size={16} />
                  </button>
                </div>
              </div>
            </div>
          </header>

          <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-10">
            {activeView === 'staff' && (
              <div className="space-y-12">
                <div className="text-center space-y-4 max-w-2xl mx-auto">
                  <h2 className="text-5xl font-display font-bold text-primary_1 tracking-tighter">Hi, {userName?.split(' ')[0]}.</h2>
                  <p className="text-gray-500 font-medium">How can I assist your workflow today?</p>
                </div>
                
                <ChatInterface onTicketCreated={handleTicketUpdate} />
                
                {tickets.length > 0 && (
                  <div className="max-w-4xl mx-auto pt-8 border-t border-gray-100">
                    <div className="flex items-center justify-between mb-6">
                       <h3 className="text-[11px] font-bold uppercase tracking-[0.2em] text-gray-400">Recent Support Sessions</h3>
                       {syncFailed && <div className="flex items-center gap-1.5 text-primary_2 text-[10px] font-bold"><AlertCircle size={12}/> Connection Interrupted</div>}
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {tickets.slice(0, 4).map(ticket => (
                        <div key={ticket.id} className="bg-white p-6 rounded-2xl border shadow-sm group hover:border-primary_3 transition-all">
                          <div className="flex justify-between items-start mb-2">
                            <span className="text-[9px] font-bold text-primary_3 uppercase tracking-[0.1em]">{ticket.category}</span>
                            <span className="text-[9px] font-bold text-gray-300 uppercase tracking-tighter">#{ticket.sharepointId || 'local'}</span>
                          </div>
                          <p className="font-bold text-primary_1 line-clamp-1">{ticket.summary}</p>
                          <div className="flex items-center justify-between mt-4">
                            <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${ticket.status === TicketStatus.CLOSED ? 'bg-gray-100 text-gray-400' : 'bg-primary_4/10 text-primary_4'}`}>
                              {ticket.status}
                            </span>
                            <span className="text-[10px] text-gray-400 font-medium">{new Date(ticket.createdAt).toLocaleDateString()}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeView === 'kb' && <KnowledgeBaseView />}
            {activeView === 'admin' && isAdmin && <AdminDashboard tickets={tickets} onStatusChange={handleStatusChange} />}
          </main>
        </div>
      </AuthenticatedTemplate>
    </>
  );
};

export default App;
