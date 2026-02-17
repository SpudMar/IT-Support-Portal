
export enum Criticality {
  HIGH = 'High',
  MEDIUM = 'Medium',
  LOW = 'Low'
}

export enum Priority {
  P1 = 'P1',
  P2 = 'P2',
  P3 = 'P3',
  P4 = 'P4'
}

export enum TicketStatus {
  NEW = 'New',
  IT_CONTACTED = 'IT Contacted',
  COURIER_DISPATCHED = 'Courier Dispatched',
  CLOSED = 'Closed'
}

export type IssueCategory =
  | 'Microsoft 365'
  | 'Identity & Access'
  | 'Xero'
  | 'Careview'
  | 'enableHR'
  | 'Hardware'
  | 'Network & Connectivity'
  | 'Security'
  | 'General';

export interface Ticket {
  id: string;
  sharepointId?: string;
  summary: string;
  userName: string;
  userEmail: string;
  userPhone?: string;
  transcript: Message[];
  criticality: Criticality;
  priority?: Priority;
  adminRequired: boolean;
  status: TicketStatus;
  category?: IssueCategory | string;
  subCategory?: string;
  location?: string;
  availability?: string;
  createdAt: number;
  thinkingLog?: string;
  securityFlag?: boolean;
  outageFlag?: boolean;
  selfServiceAttempted?: boolean;
  selfServiceResult?: 'resolved' | 'not_resolved' | 'not_attempted' | 'security_bypass';
}

export interface Message {
  role: 'user' | 'model' | 'system';
  content: string;
  image?: string;
  isThinking?: boolean;
}

export interface KBArticle {
  id: string;
  title: string;
  category: string;
  content: string;
  keywords: string[];
}
