using LibGit2Sharp;

namespace Irudd.Piploy.Test;

public class FakeGitRepository(string directory)
{
    //https://github.com/libgit2/libgit2sharp/wiki/LibGit2Sharp-Hitchhiker%27s-Guide-to-Git

    public const string InitialFilename = "initial-file.txt";
    public const string SecondFilename = "update-file.txt";

    public FakeGitRepository CreateEmpty()
    {
        Directory.CreateDirectory(directory);
        Repository.Init(directory);

        return this;
    }

    public FakeGitRepository CreateWithInitialFile()
    {
        CreateEmpty();

        using var repo = new Repository(directory);

        AddFileAndCommit(repo, InitialFilename, "abc123");
        return this;
    }

    public FakeGitRepository AddSecondFile()
    {
        using var repo = new Repository(directory);

        AddFileAndCommit(repo, SecondFilename, "xyz789");
        return this;
    }

    private Commit AddFileAndCommit(Repository repo, string filename, string content)
    {
        File.WriteAllText(Path.Combine(directory, filename), content);

        // Stage
        repo.Index.Add(filename);
        repo.Index.Write();

        // Commit
        Signature author = new Signature("anon", "anon@example.org", DateTimeOffset.Now);
        return repo.Commit($"Added {filename}", author, author);
    }
}
