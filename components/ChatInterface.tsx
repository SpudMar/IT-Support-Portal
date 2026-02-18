
import React, { useState, useRef, useEffect } from 'react';
import { Send, Camera, User, Bot, CheckCircle2, BookOpen, Info } from 'lucide-react';
import { chatWithGemini } from '../services/geminiService';
import { Message, Ticket, Criticality } from '../types';

interface ChatInterfaceProps {
  onTicketCreated: (ticket: Partial<Ticket>) => void;
  resumeTicket?: Ticket | null;
}

const ChatInterface: React.FC<ChatInterfaceProps> = ({ onTicketCreated, resumeTicket }) => {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'model', content: "G'day! I'm your Lotus Assist IT Co-pilot. What's going on \u2014 having trouble with something?" }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [image, setImage] = useState<string | null>(null);
  const [lastIncident, setLastIncident] = useState<any>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(scrollToBottom, [messages]);

  // Resume conversation when resumeTicket is provided
  useEffect(() => {
    if (resumeTicket && resumeTicket.transcript && resumeTicket.transcript.length > 0) {
      setMessages(resumeTicket.transcript as Message[]);
      setLastIncident({
        summary: resumeTicket.summary,
        category: resumeTicket.category,
        criticality: resumeTicket.criticality
      });
    }
  }, [resumeTicket]);

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!input.trim() && !image) return;

    const userMsg: Message = { role: 'user', content: input, image: image || undefined };
    const currentMessages = [...messages, userMsg];
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setImage(null);
    setIsLoading(true);

    try {
      // Backend handles all Gemini calls, KB search, and function execution server-side
      const response = await chatWithGemini(currentMessages, image || undefined);

      // Handle incident data if the AI decided to log an incident
      if (response.incidentData) {
        const args = response.incidentData;
        const priorityToCriticality: Record<string, Criticality> = {
          'P1': Criticality.HIGH,
          'P2': Criticality.HIGH,
          'P3': Criticality.MEDIUM,
          'P4': Criticality.LOW,
        };
        onTicketCreated({
          summary: args.summary,
          category: args.category,
          criticality: priorityToCriticality[args.priority] || Criticality.MEDIUM,
          adminRequired: args.admin_required,
          transcript: currentMessages,
          thinkingLog: [
            `Priority: ${args.priority}`,
            args.sub_category ? `Sub-category: ${args.sub_category}` : null,
            args.self_service_attempted ? `Self-service attempted: ${args.self_service_result || 'not_resolved'}` : 'Self-service: not attempted',
            args.security_flag ? 'SECURITY INCIDENT' : null,
            args.outage_flag ? 'POTENTIAL OUTAGE' : null,
            args.ai_recommended_actions?.length ? `Recommended: ${args.ai_recommended_actions.join('; ')}` : null,
          ].filter(Boolean).join(' | ')
        });
        setLastIncident(args);
      }

      // Add the AI response text to the conversation
      if (response.text) {
        setMessages(prev => [...prev, { role: 'model', content: response.text }]);
      }
    } catch (error) {
      console.error("Chat error:", error);
      setMessages(prev => [...prev, { role: 'model', content: "Network error. Try again?" }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => setImage(reader.result as string);
      reader.readAsDataURL(file);
    }
  };

  return (
    <div className="flex flex-col h-[65vh] md:h-[70vh] max-w-4xl mx-auto bg-white rounded-[2rem] shadow-2xl overflow-hidden border border-gray-100 ring-1 ring-black/5">
      <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-6 bg-pale_grey/30">
        {messages.filter(msg => msg.role !== 'system').map((msg, idx) => (
          <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`flex gap-4 max-w-[85%] ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
              <div className={`w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center shadow-md ${msg.role === 'user' ? 'bg-primary_2 text-white' : 'bg-white text-primary_1 border border-gray-100'}`}>
                {msg.role === 'user' ? <User size={20} /> : <Bot size={20} />}
              </div>
              <div className={`rounded-2xl p-5 shadow-sm transition-all hover:shadow-md ${msg.role === 'user' ? 'bg-primary_2 text-white rounded-tr-none' : 'bg-white text-primary_1 rounded-tl-none border border-gray-100'
                }`}>
                {msg.image && <img src={msg.image} alt="Diagnostic" className="rounded-xl mb-4 max-h-64 w-auto object-cover border-4 border-white shadow-lg" />}
                <p className="whitespace-pre-wrap text-sm md:text-[15px] leading-relaxed font-medium">{msg.content}</p>
              </div>
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-start p-4"><Loader2 className="animate-spin text-primary_3" /></div>
        )}
        {lastIncident && (
          <div className="bg-primary_4/5 border-2 border-primary_4/10 p-5 rounded-[1.5rem] flex items-start gap-4 mt-6">
            <CheckCircle2 size={24} className="text-primary_4" />
            <div>
              <p className="font-display font-bold text-primary_1">Incident Logged: {lastIncident.summary}</p>
              <p className="text-[10px] text-primary_2 font-bold uppercase tracking-widest">
                {lastIncident.priority} {lastIncident.security_flag ? '| SECURITY' : ''} {lastIncident.outage_flag ? '| OUTAGE' : ''} | Routing to: {lastIncident.category} Admin
              </p>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="p-6 bg-white border-t">
        <form onSubmit={handleSend} className="flex items-end gap-3 max-w-4xl mx-auto">
          <div className="flex-1 bg-pale_grey rounded-2xl border-2 border-transparent focus-within:border-primary_3 transition-all">
            <textarea
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Tell me what's happening..."
              className="w-full p-4 bg-transparent outline-none text-sm font-medium"
            />
          </div>
          <button type="button" onClick={() => fileInputRef.current?.click()} className="p-4 bg-pale_grey rounded-2xl"><Camera size={22} /></button>
          <button type="submit" disabled={isLoading} className="p-4 bg-primary_2 text-white rounded-2xl shadow-xl"><Send size={22} /></button>
        </form>
        <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleFileChange} />
      </div>
    </div>
  );
};

const Loader2 = ({ className }: { className?: string }) => <div className={`w-6 h-6 border-2 border-t-transparent rounded-full animate-spin ${className}`}></div>;

export default ChatInterface;
