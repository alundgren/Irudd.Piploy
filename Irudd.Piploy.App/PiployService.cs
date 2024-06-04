using LibGit2Sharp;
using Microsoft.Extensions.Options;

namespace Irudd.Piploy.App;

public class PiployService(IOptions<PiploySettings> settings)
{
    /*
     Git library documentation:
    https://github.com/libgit2/libgit2sharp/wiki/LibGit2Sharp-Hitchhiker%27s-Guide-to-Git
     */
    private PiploySettings Settings => settings.Value;

    /// <summary>
    /// Make sure we have up to date copies of all the applications git repositories.
    /// </summary>
    public async Task EnsureLocalRepositoriesAsync()
    {
        if (!Directory.Exists(Settings.RootDirectory))
            Directory.CreateDirectory(Settings.RootDirectory);

        foreach(var application in Settings.Applications)
        {
            var repoDirectory = application.GetRepoDirectory(Settings);
            if (!Directory.Exists(repoDirectory))
                Directory.CreateDirectory(repoDirectory);

            if(Directory.Exists(Path.Combine(repoDirectory, ".git")))
            {
                using var repo = new Repository(repoDirectory);

                //git fetch origin
                var remote = repo.Network.Remotes[repo.Head.RemoteName];
                var refSpecs = remote.FetchRefSpecs.Select(x => x.Specification);
                Commands.Fetch(repo, remote.Name, refSpecs, new FetchOptions { }, "");

                var remoteBranchRef = repo.Branches[$"{repo.Head.RemoteName}/{repo.Head.FriendlyName}"];
                if (remoteBranchRef.Tip != repo.Head.Tip)
                {
                    //git reset --hard origin/master
                    var commit = remoteBranchRef.Tip;
                    repo.Reset(ResetMode.Hard, remoteBranchRef.Tip);
                }
            }
            else
            {
                Repository.Clone(application.GitRepositoryUrl, repoDirectory);
            }
        }
    }
}
