using Docker.DotNet;
using Docker.DotNet.Models;
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

async Task Poll(InvocationContext context)
{
    var host = HostBuilder.CreateConfigOnlyHost(args);
    var service = host.Services.GetRequiredService<PiployService>();
    await service.EnsureLocalRepositoriesAsync();
}

async Task Test(InvocationContext context)
{
    //https://github.com/dotnet/Docker.DotNet
    DockerClient client = new DockerClientConfiguration()
         .CreateClient();

    IList<ContainerListResponse> containers = await client.Containers.ListContainersAsync(
        new ContainersListParameters()
        {
            Limit = 10,
        });
    foreach(var container in containers)
    {
        Console.WriteLine(container.Command);
    }
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