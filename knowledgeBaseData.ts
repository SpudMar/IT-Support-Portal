
export interface KBArticle {
  id: string;
  title: string;
  category: string;
  content: string;
  keywords: string[];
}

export const KNOWLEDGE_BASE: KBArticle[] = [
  {
    id: 'kb-001',
    title: 'Careview 403 Forbidden Error',
    category: 'Careview',
    content: '1. Verify your NDIS Worker Screening status is current.\n2. Ensure the Lotus VPN is active if working remotely.\n3. Try clearing your browser cache or opening Careview in an Incognito window.',
    keywords: ['careview', 'access', '403', 'forbidden', 'ndis']
  },
  {
    id: 'kb-002',
    title: 'Xero Payroll Access Permissions',
    category: 'Xero',
    content: 'Payroll access requires the "Payroll Admin" role. If you cannot see the Payroll tab, please contact the Accounts Manager to verify your permissions in Xero Settings.',
    keywords: ['xero', 'payroll', 'login', 'access', 'accounts']
  },
  {
    id: 'kb-003',
    title: 'enableHR Password Reset',
    category: 'enableHR',
    content: 'Visit the Lotus enableHR portal and click "Forgot Password". A reset link will be sent to your work email. Remember to check your "Junk" folder.',
    keywords: ['hr', 'enablehr', 'password', 'reset', 'login']
  },
  {
    id: 'kb-004',
    title: 'VPN Connection Issues (GlobalProtect)',
    category: '365',
    content: '1. Verify the portal address is "vpn.lotusassist.com.au".\n2. If it spins infinitely, restart your computer or restart the "PanGPS" service in Windows Services.\n3. Ensure you are not on a public network that blocks VPN traffic.',
    keywords: ['vpn', 'globalprotect', 'remote', '365', 'timeout']
  },
  {
    id: 'kb-005',
    title: 'Hardware: Laptop Noisy Fan or Overheating',
    category: 'Hardware',
    content: '1. Ensure the laptop is on a hard, flat surface (not a bed or couch).\n2. Check for dust in the side vents.\n3. If the noise persists, it may be a bearing failure. Use the chat to request a hardware inspection.',
    keywords: ['hardware', 'fan', 'noise', 'laptop', 'overheating']
  }
];

export function searchKB(query: string): KBArticle[] {
  const q = query.toLowerCase();
  return KNOWLEDGE_BASE.filter(article => 
    article.title.toLowerCase().includes(q) || 
    article.content.toLowerCase().includes(q) ||
    article.keywords.some(k => k.includes(q))
  );
}
