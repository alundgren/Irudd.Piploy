using LibGit2Sharp;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Irudd.Piploy.App;

//TODO: Support using a different branch than HEAD
public class PiployGitService(IOptions<PiploySettings> settings, ILogger<PiployGitService> logger)
{
    /*
     Git library documentation:
    https://github.com/libgit2/libgit2sharp/wiki/LibGit2Sharp-Hitchhiker%27s-Guide-to-Git
     */
    private PiploySettings Settings => settings.Value;

    public void EnsureLocalRepositories() => Settings.Applications.ForEach(EnsureLocalRepository);

    /// <summary>
    /// Make sure we have up to date copies of all the applications git repositories.
    /// </summary>
    public void EnsureLocalRepository(PiploySettings.Application application)
    {
        using var _ = logger.BeginPiployGitRepositoryScope(application.GitRepositoryUrl);

        var repoDirectory = application.GetRepoDirectory(Settings);
        if (!Directory.Exists(repoDirectory))
            Directory.CreateDirectory(repoDirectory);

        if(Directory.Exists(Path.Combine(repoDirectory, ".git")))
        {
            using var repo = new Repository(repoDirectory);

            //git fetch origin
            logger.LogInformation("Local exists. Fetching origin");

            var remote = repo.Network.Remotes[repo.Head.RemoteName];
            var refSpecs = remote.FetchRefSpecs.Select(x => x.Specification);
            Commands.Fetch(repo, remote.Name, refSpecs, new FetchOptions { }, "");

            var remoteBranchRef = repo.Branches[$"{repo.Head.RemoteName}/{repo.Head.FriendlyName}"];
            if (remoteBranchRef.Tip != repo.Head.Tip)
            {
                //git reset --hard origin/<branch>
                logger.LogInformation($"Latest remote commit {remoteBranchRef.Tip.Sha} is ahead of local. Resetting local to match");
                var commit = remoteBranchRef.Tip;
                repo.Reset(ResetMode.Hard, remoteBranchRef.Tip);
            }
            else
            {
                logger.LogInformation("Local is up-to-date with remote already");
            }
        }
        else
        {
            logger.LogInformation("Cloning into remote");
            Repository.Clone(application.GitRepositoryUrl, repoDirectory);
        }
    }

    public GitCommit GetLatestCommit(PiploySettings.Application application)
    {
        using var repo = new Repository(application.GetRepoDirectory(Settings));
        return GitCommit.FromLibGit2SharpCommit(repo.Head.Tip);
    }
}
