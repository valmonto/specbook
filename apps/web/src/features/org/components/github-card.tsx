import { useTranslation } from 'react-i18next';
import { k } from '@pkg/locales';
import { ExternalLink, GitBranch, Loader2, Lock } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/shared/auth/auth-context';
import { useCan } from '@/shared/hooks/use-permissions';
import { useDisconnectGithub, useGithubStatus } from '@/shared/github/use-github';

/**
 * The org ↔ GitHub App connection. Connect is a redirect to GitHub's own
 * consent screen (where the human picks WHICH repositories — never all);
 * GitHub returns to /settings/github which stores the installation. The repo
 * list here is exactly what the installation grants, live from GitHub.
 */
export function GithubCard() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const orgId = user?.orgId;
  const { data, isLoading } = useGithubStatus(orgId);
  const disconnect = useDisconnectGithub(orgId);
  const canUpdate = useCan('settings:update');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GitBranch className="size-4" />
          {t(k.orgs.github.title)}
        </CardTitle>
        <CardDescription>{t(k.orgs.github.description)}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : !data.configured ? (
          <p className="text-sm text-muted-foreground">{t(k.orgs.github.notConfigured)}</p>
        ) : !data.connected ? (
          canUpdate &&
          data.installUrl && (
            <Button asChild>
              <a href={data.installUrl}>
                <GitBranch className="size-4" />
                {t(k.orgs.github.connect)}
              </a>
            </Button>
          )
        ) : (
          <div className="grid gap-4">
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="gap-1.5">
                <span className="size-1.5 rounded-full bg-emerald-500" />
                {t(k.orgs.github.connectedAs, { account: data.accountLogin ?? '?' })}
              </Badge>
            </div>
            <div className="grid gap-1.5">
              <p className="text-sm font-medium">{t(k.orgs.github.repositories)}</p>
              {data.repositories.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t(k.orgs.github.noRepos)}</p>
              ) : (
                <ul className="divide-y rounded-lg border">
                  {data.repositories.map((repo) => (
                    <li key={repo.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                      <code className="font-mono text-xs">{repo.fullName}</code>
                      {repo.private && (
                        <Badge variant="outline" className="gap-1 text-[10px]">
                          <Lock className="size-2.5" />
                          {t(k.orgs.github.private)}
                        </Badge>
                      )}
                      <a
                        href={repo.htmlUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-auto text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink className="size-3.5" />
                      </a>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-muted-foreground">{t(k.orgs.github.reposHint)}</p>
            </div>
          </div>
        )}
      </CardContent>
      {data?.connected && canUpdate && (
        <CardFooter className="flex items-center gap-3">
          <Button
            variant="outline"
            className="text-destructive"
            disabled={disconnect.isLoading}
            onClick={() => orgId && void disconnect.execute({ orgId })}
          >
            {t(k.orgs.github.disconnect)}
          </Button>
          <p className="text-xs text-muted-foreground">{t(k.orgs.github.disconnectHint)}</p>
        </CardFooter>
      )}
    </Card>
  );
}
