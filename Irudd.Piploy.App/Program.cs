using Irudd.Piploy.App;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using System.CommandLine;
using System.CommandLine.Invocation;

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

var rootCommand = new RootCommand("piploy raspberry pi + git + docker host");
rootCommand.SetHandler(Status);

void AddCommand(string name, string description, Func<InvocationContext, Task> handle)
{
    var command = new Command(name, description);
    command.SetHandler(handle);
    rootCommand.Add(command);
}

AddCommand("status", "Service status", Status);
AddCommand("service", "Run as service", Service);
AddCommand("poll", "Poll for changes now", Poll);

await rootCommand.InvokeAsync(args);