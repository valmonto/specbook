import { useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { k } from '@pkg/locales';
import { CheckCircle2, GitBranch, Loader2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/shared/auth/auth-context';
import { useConnectGithub } from '@/shared/github/use-github';

/**
 * The GitHub App's Setup URL: after (un)installing or editing the
 * installation, GitHub redirects here with ?installation_id=…. The id is not
 * a secret and not trusted — the server verifies it against GitHub (it must
 * exist and belong to OUR App) before binding it to the active org.
 */
export default function SettingsGithubPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const { user } = useAuth();
  const orgId = user?.orgId;
  const connect = useConnectGithub(orgId);
  const fired = useRef(false);

  const installationId = Number(params.get('installation_id'));
  const valid = Number.isInteger(installationId) && installationId > 0;

  useEffect(() => {
    if (!valid || !orgId || fired.current) return;
    fired.current = true;
    void connect.execute({ orgId, installationId });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire exactly once per mount
  }, [valid, orgId]);

  const body = !valid ? (
    <p className="text-sm text-muted-foreground">{t(k.orgs.github.missingInstallationId)}</p>
  ) : connect.error ? (
    <div className="flex items-center gap-2 text-sm text-destructive">
      <XCircle className="size-4" />
      {t(k.orgs.github.connectFailed)}: {t(connect.error.message)}
    </div>
  ) : connect.isLoading || !orgId ? (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      {t(k.orgs.github.connecting)}
    </div>
  ) : (
    <div className="flex items-center gap-2 text-sm">
      <CheckCircle2 className="size-4 text-emerald-500" />
      {t(k.orgs.github.connectSuccess)}
    </div>
  );

  return (
    <div className="mx-auto max-w-lg pt-12">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GitBranch className="size-4" />
            {t(k.orgs.github.title)}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          {body}
          <Button asChild variant="outline" className="w-fit">
            <Link to="/settings?tab=organization">{t(k.orgs.github.backToSettings)}</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
