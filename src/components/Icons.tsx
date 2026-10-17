type P = { size?: number; className?: string };
const base = (size = 20) => ({
  width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
  strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true,
});

export const ArrowUp = ({ size, className }: P) => (
  <svg {...base(size)} className={className} strokeWidth={2.6}><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" /></svg>
);
export const Play = ({ size, className }: P) => (
  <svg {...base(size)} className={className}><path d="M7 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L8.5 4.64A1 1 0 0 0 7 5.5Z" fill="currentColor" stroke="none" /></svg>
);
export const Check = ({ size, className }: P) => (
  <svg {...base(size)} className={className} strokeWidth={2.8}><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
);
export const Undo = ({ size, className }: P) => (
  <svg {...base(size)} className={className}><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>
);
export const Trash = ({ size, className }: P) => (
  <svg {...base(size)} className={className}><path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 12a2 2 0 0 0 2 1.8h7a2 2 0 0 0 2-1.8l1-12M9 7V4.8A.8.8 0 0 1 9.8 4h4.4a.8.8 0 0 1 .8.8V7" /></svg>
);
export const Sparkle = ({ size, className }: P) => (
  <svg {...base(size)} className={className} stroke="none" fill="currentColor">
    <path d="M12 2.5c.4 3.9 2.1 6.1 6.5 6.9-4.4.8-6.1 3-6.5 6.9-.4-3.9-2.1-6.1-6.5-6.9 4.4-.8 6.1-3 6.5-6.9Z" />
    <path d="M18.5 14.5c.2 1.8 1 2.8 3 3.2-2 .4-2.8 1.4-3 3.2-.2-1.8-1-2.8-3-3.2 2-.4 2.8-1.4 3-3.2Z" opacity=".7" />
  </svg>
);
export const Calendar = ({ size, className }: P) => (
  <svg {...base(size)} className={className}><rect x="3.5" y="5" width="17" height="15.5" rx="3.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>
);
export const Tray = ({ size, className }: P) => (
  <svg {...base(size)} className={className} strokeWidth={1.4}><path d="M3 13.5 5.6 6a2 2 0 0 1 1.9-1.4h9a2 2 0 0 1 1.9 1.4L21 13.5V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4.5Z" /><path d="M3 13.5h5l1.5 2.5h5l1.5-2.5h5" /></svg>
);
export const Wifi = ({ size, className }: P) => (
  <svg {...base(size)} className={className}><path d="M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5-2.7M14.5 10.4A10 10 0 0 1 19 13M2 9.5a15 15 0 0 1 4.3-2.6M11 6.1a15 15 0 0 1 11 3.4" /><circle cx="12" cy="20" r=".8" fill="currentColor" /></svg>
);
export const Google = ({ size = 20 }: P) => (
  <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
    <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
    <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
    <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
  </svg>
);
