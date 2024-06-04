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

    Console.WriteLine($"Host root: {settings.RootDirectory}");

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
    var service = host.Services.GetRequiredService<PiployService>();
    await service.EnsureLocalRepositoriesAsync();
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