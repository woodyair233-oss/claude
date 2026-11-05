import { ClipboardCheck, ShieldCheck } from 'lucide-react';
import { useApp } from '../lib/store';
import { t } from '../lib/i18n';
import { Toolbar } from '../components/Toolbar';
import { EmptyState } from '../components/ui';
import { ApprovalCard } from '../components/Approval';

export function ApprovalsView() {
  const pending = useApp((s) => s.snap!.gateway.pending);
  const timeout = useApp((s) => s.snap!.settings.ai.approvalTimeoutSec);
  return (
    <>
      <Toolbar title={t('Approvals')} subtitle={pending.length ? t('{n} waiting', { n: pending.length }) : undefined} />
      <div className="content">
        {pending.length === 0 ? (
          <EmptyState icon={<ShieldCheck size={40} strokeWidth={1.5} />} title={t('Nothing waiting for you')}>
            {t('When Claude asks to do something your policy does not allow automatically, it appears here — and as a notification. Unanswered requests are denied after {n} seconds.', { n: timeout })}
          </EmptyState>
        ) : (
          <div className="page page-narrow">
            <div className="approvals-list">
              {pending.map((req, i) => (
                <ApprovalCard key={req.id} req={req} autoFocus={i === 0} />
              ))}
            </div>
            <p className="faint" style={{ textAlign: 'center', marginTop: 18, fontSize: 12 }}>
              <ClipboardCheck size={12} style={{ verticalAlign: -2 }} /> {t('Unanswered requests are denied automatically after {n} seconds.', { n: timeout })}
            </p>
          </div>
        )}
      </div>
    </>
  );
}
