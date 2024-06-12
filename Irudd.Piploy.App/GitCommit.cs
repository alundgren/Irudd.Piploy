namespace Irudd.Piploy.App;

public class GitCommit
{
    public GitCommit(LibGit2Sharp.Commit source)
    {
        /*
         * Beware:
         * Dont refactor this to read from source in the getters.
         * At least Commiter.When will cause a memory corruption error from libgit2
         * if the Repository is disposed when reading from source.
         */ 
        Hash = source.Sha;
        Date = source.Committer.When;
        Message = source.Message.TrimEnd();
    }
    public string Hash { get; }
    public DateTimeOffset Date { get; }
    public string Message { get; }
}