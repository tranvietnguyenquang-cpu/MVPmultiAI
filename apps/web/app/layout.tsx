import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = { title: "ProjectRelay", description: "Verified context continuity for AI-assisted software projects." };
const nav = [["/","Projects"],...(process.env.RELAY_V2_ENABLED!=="false"?[["/v2","Relay v2"]]:[]),["/sessions","Agent sessions"],["/memory","Project memory"],["/decisions","Decisions"],["/checkpoints","Checkpoints"],["/evidence","Evidence"],["/settings","Settings"]];
export default function RootLayout({ children }: Readonly<{children: React.ReactNode}>) { return <html lang="en"><body><div className="shell"><aside className="sidebar"><div className="brand">Project<span>Relay</span></div><nav className="nav">{nav.map(([href,label])=><Link href={href!} key={label}>{label}</Link>)}</nav></aside><main className="main">{children}</main></div></body></html>; }
