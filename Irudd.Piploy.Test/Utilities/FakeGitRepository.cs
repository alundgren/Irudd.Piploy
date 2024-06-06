using Irudd.Piploy.App;
using LibGit2Sharp;

namespace Irudd.Piploy.Test.Utilities;

public class FakeGitRepository(string directory)
{
    //https://github.com/libgit2/libgit2sharp/wiki/LibGit2Sharp-Hitchhiker%27s-Guide-to-Git

    public const string InitialFilename = "initial-file.txt";
    public const string SecondFilename = "update-file.txt";

    public void CreateEmpty()
    {
        Directory.CreateDirectory(directory);
        Repository.Init(directory);
    }

    public void CreateWithInitialFile()
    {
        CreateEmpty();

        using var repo = new Repository(directory);

        AddFileAndCommit(repo, InitialFilename, "abc123");
    }

    public (string App1Directory, string App2Directory, GitCommit Commit) CreateWithDockerfiles()
    {
        CreateEmpty();

        using var repo = new Repository(directory);

        /*
         * Creates and two directories in the repo app1 and app2
         * so we can test that we can point to docker files not in the root
         * and have files be included correctly.
         * 
         * Borrowed from: https://github.com/nginxinc/NGINX-Demos/
        */

        string AddDockerDirectory(string directoryName)
        {
            var fullDirectory = Path.Combine(directory, directoryName);
            Directory.CreateDirectory(fullDirectory);

            AddAndStageTextFile(repo, "Dockerfile", @"FROM nginx:mainline-alpine
RUN rm /etc/nginx/conf.d/*
ADD hello.conf /etc/nginx/conf.d/
ADD index.html /usr/share/nginx/html/", overrideDirectory: fullDirectory);

            AddAndStageTextFile(repo, "hello.conf", @"server {
    listen 80;
    listen [::]:80;

    root /usr/share/nginx/html;
    try_files /index.html =404;

    expires -1;

    sub_filter_once off;
    sub_filter 'server_hostname' '$hostname';
    sub_filter 'server_address' '$server_addr:$server_port';
    sub_filter 'server_url' '$request_uri';
    sub_filter 'server_date' '$time_local';
    sub_filter 'request_id' '$request_id';
}", overrideDirectory: fullDirectory);

            AddAndStageTextFile(repo, "index.html", @"<!DOCTYPE html>
<html>
<head>
<title>Hello World</title>
</head>
<body>
<div>
    <p><span>App</span> <span>{{AppName}}</span></p>
    <p><span>Server&nbsp;address:</span> <span>server_address</span></p>
    <p><span>Server&nbsp;name:</span> <span>server_hostname</span></p>
    <p><span>Date:</span> <span>server_date</span></p>
    <p><span>URI:</span> <span>server_url</span></p>
    <p><span>Request ID:</span> <span>request_id</span></p>
</div>
</body>
</html>".Replace("{{AppName}}", directoryName), overrideDirectory: fullDirectory);

            return fullDirectory;
        }

        var app1Directory = AddDockerDirectory("app1");
        var app2Directory = AddDockerDirectory("app2");

        var commit = CommitChanges(repo, $"Added docker example");        
        return (app1Directory, app2Directory, new GitCommit(commit.Sha));
    }

    public void AddSecondFile()
    {
        using var repo = new Repository(directory);

        AddFileAndCommit(repo, SecondFilename, "xyz789");
    }

    private Commit AddFileAndCommit(Repository repo, string filename, string content)
    {
        AddAndStageTextFile(repo, filename, content);
        return CommitChanges(repo, $"Added {filename}");
    }

    private Commit CommitChanges(Repository repo, string comment)
    {
        Signature author = new Signature("anon", "anon@example.org", DateTimeOffset.Now);
        return repo.Commit(comment, author, author);
    }

    private void AddAndStageTextFile(Repository repo, string filename, string content, string? overrideDirectory = null)
    {
        var filePath = Path.Combine(overrideDirectory ?? directory, filename);
        File.WriteAllText(filePath, content);
        var fileRepoPath = Path.GetRelativePath(directory, filePath);
        repo.Index.Add(fileRepoPath);
        repo.Index.Write();
    }
}
