namespace Irudd.Piploy.App;

public class GitCommit(string value)
{
    public string Value => value;

    public static GitCommit FromLibGit2SharpCommit(LibGit2Sharp.Commit commit) => new GitCommit(commit.Sha);
}