import { redirect } from 'next/navigation';
import { getCurrentProfile } from '@/lib/auth/session';
import { toDisplayUnits } from '@/lib/token-units';
import Sidebar from '@/components/dashboard/Sidebar';
import TopBar from '@/components/dashboard/TopBar';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const result = await getCurrentProfile();

  if (!result) {
    redirect('/login');
  }

  const { user, profile } = result;

  const userEmail = user.email ?? 'user@example.com';
  const fullName = profile?.fullName ?? userEmail;
  const initials = fullName
    .split(' ')
    .map((n: string) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || userEmail[0].toUpperCase();
  // Numbers shown in the sidebar are driven ONLY by what's on the profile row;
  // no fake defaults. If the DB has 0/null, we render 0/0 — a visible
  // "out of tokens" state beats a made-up "50/50" that doesn't reflect reality.
  const tokensRemaining = toDisplayUnits(profile?.tokensRemaining)
  const tokensTotal = toDisplayUnits(profile?.tokensTotal)
  const plan = profile?.plan ?? 'free'

  return (
    <div className="min-h-screen bg-[#050A18]">
      <Sidebar tokensRemaining={tokensRemaining} tokensTotal={tokensTotal} plan={plan} />
      <div className="lg:ml-[260px] flex flex-col min-h-screen">
        <TopBar userEmail={userEmail} userInitials={initials} />
        <main className="flex-1 dot-grid relative">
          <div className="absolute inset-0 bg-gradient-to-b from-[#050A18]/50 via-transparent to-[#050A18]/30 pointer-events-none" />
          <div className="relative p-6">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
