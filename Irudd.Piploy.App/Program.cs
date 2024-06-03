using Irudd.Piploy.App;
using LibGit2Sharp;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using System.CommandLine;
using System.CommandLine.Invocation;
using System.Diagnostics.Metrics;

using CancellationTokenSource tokenSource = new CancellationTokenSource();

Task Status(InvocationContext context)
{
    var host = HostBuilder.CreateConfigOnlyHost(args);
    var settings = host.Services.GetRequiredService<IOptions<PiploySettings>>().Value;

    Console.WriteLine($"Host root: {settings.RootFolder}");

    foreach(var application in settings.Applications)
    {
        Console.WriteLine();
        Console.WriteLine($"Application: {application.GitRepositoryUrl}");
        Console.WriteLine("Status: Ok");
    }

    return Task.CompletedTask;
}

async Task Service(InvocationContext context)
{
    var host = HostBuilder.CreateServiceHost(args);
    await host.StartAsync(tokenSource.Token);
}

Task Poll(InvocationContext context)
{
    Console.WriteLine("Polling for changes");
    return Task.CompletedTask;
}

async Task Test(InvocationContext context)
{
    var host = HostBuilder.CreateConfigOnlyHost(args);
    var settings = host.Services.GetRequiredService<IOptions<PiploySettings>>().Value;

    //Ensure root exists
    if (!Directory.Exists(settings.RootFolder))
        Directory.CreateDirectory(settings.RootFolder);

    foreach (var application in settings.Applications)
    {
        //Ensure application root exists
        var applicationRoot = Path.Combine(settings.RootFolder, application.Name);
        if (!Directory.Exists(applicationRoot))
            Directory.CreateDirectory(applicationRoot);

        //TODO: Check for changes here but lets just always assume changes for now

        //Check if the git repo exists
        var gitMarkerDirectory = Path.Combine(applicationRoot, ".git");
        if (Directory.Exists(gitMarkerDirectory))
        {
            using var repo = new Repository(applicationRoot);

            //git fetch origin
            var remote = repo.Network.Remotes[repo.Head.RemoteName];
            var refSpecs = remote.FetchRefSpecs.Select(x => x.Specification);
            Commands.Fetch(repo, remote.Name, refSpecs, new FetchOptions { }, "");

            var remoteBranchRef = repo.Branches[$"{repo.Head.RemoteName}/{repo.Head.FriendlyName}"];
            if(remoteBranchRef.Tip != repo.Head.Tip)
            {
                //git reset --hard origin/master
                var commit = remoteBranchRef.Tip;
                repo.Reset(ResetMode.Hard, remoteBranchRef.Tip);
            }
            else
            {
                Console.WriteLine("All up to date");
            }
        }
        else
        {
            //Clone the repo to applicationRoot
            /*
            To support username/password
            var co = new CloneOptions();
            co.FetchOptions.CredentialsProvider = (_url, _user, _cred) => new UsernamePasswordCredentials { Username = "Username", Password = "Password" };
            Repository.Clone("https://github.com/libgit2/libgit2sharp.git", "path/to/repo", co);             
             */
            Repository.Clone(application.GitRepositoryUrl, applicationRoot);
        }
    }

    //Docs: https://github.com/libgit2/libgit2sharp/wiki/LibGit2Sharp-Hitchhiker%27s-Guide-to-Git
}

var rootCommand = new RootCommand("piploy raspberry pi + git + docker host");
rootCommand.SetHandler(Test);

void AddCommand(string name, string description, Func<InvocationContext, Task> handle)
{
    var command = new Command(name, description);
    command.SetHandler(handle);
    rootCommand.Add(command);
}

AddCommand("status", "Service status", Status);
AddCommand("service", "Run as service", Service);
AddCommand("poll", "Poll for changes now", Poll);
AddCommand("test", "Temp test", Test);

await rootCommand.InvokeAsync(args);