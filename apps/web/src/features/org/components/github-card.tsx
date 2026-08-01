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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAuth } from '@/shared/auth/auth-context';
import { useCan } from '@/shared/hooks/use-permissions';
import {
  useDisconnectGithub,
  useGithubStatus,
  useUpdateGithubSettings,
} from '@/shared/github/use-github';

/** Sentinel: shadcn Select cannot hold an empty-string value. */
const NO_TEMPLATE = 'none';

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
  const updateSettings = useUpdateGithubSettings(orgId);
  const canUpdate = useCan('settings:update');

  const templates = data?.repositories.filter((repo) => repo.isTemplate) ?? [];
  const pickTemplate = (value: string) => {
    if (!orgId) return;
    void updateSettings.execute({
      orgId,
      templateRepo: value === NO_TEMPLATE ? null : value,
    });
  };

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
                      {repo.isTemplate && (
                        <Badge variant="outline" className="text-[10px]">
                          {t(k.orgs.github.templateBadge)}
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
            {/* The org's provisioning template — an ORG setting, not deploy
                config. Choices are limited to granted repos GitHub flags as
                templates; the server re-validates the same rule. */}
            {canUpdate && (
              <div className="grid max-w-md gap-1.5">
                <p className="text-sm font-medium">{t(k.orgs.github.template)}</p>
                <Select
                  value={data.templateRepo ?? NO_TEMPLATE}
                  onValueChange={pickTemplate}
                  disabled={updateSettings.isLoading}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_TEMPLATE}>{t(k.orgs.github.templateNone)}</SelectItem>
                    {templates.map((repo) => (
                      <SelectItem key={repo.id} value={repo.fullName}>
                        <code className="font-mono text-xs">{repo.fullName}</code>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{t(k.orgs.github.templateHint)}</p>
                {updateSettings.error && (
                  <p className="text-xs text-destructive">{t(updateSettings.error.message)}</p>
                )}
              </div>
            )}
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
