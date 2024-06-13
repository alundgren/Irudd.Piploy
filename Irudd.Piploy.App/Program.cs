using Irudd.Piploy.App;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using System.CommandLine;
using System.CommandLine.Invocation;

using CancellationTokenSource tokenSource = new CancellationTokenSource();

async Task Status(InvocationContext context)
{
    var host = PiployHostBuilder.CreateConfigOnlyHost(args);
    var service = host.Services.GetRequiredService<PiployService>();
    var statusText = await service.GetStatusText(tokenSource.Token);
    Console.WriteLine(statusText);
}

async Task StartService(InvocationContext context)
{
    var host = PiployHostBuilder.CreateServiceHost(args);
    await host.RunAsync();
}

async Task StopService(InvocationContext context)
{
    await PiployBackgroundService.SendCommand("stop", tokenSource.Token);
}

async Task Poll(InvocationContext context)
{    
    if(await PiployBackgroundService.IsBackgroundServiceRunning(tokenSource.Token))
    {
        Console.WriteLine("Background service running. Sending the poll command there");
        await PiployBackgroundService.SendCommand("poll", tokenSource.Token);
    }
    else
    {
        var host = PiployHostBuilder.CreateConfigOnlyHost(args);
        var service = host.Services.GetRequiredService<PiployService>();
        await service.Poll(tokenSource.Token);
    }
}

async Task WipeAll(InvocationContext context)
{
    var host = PiployHostBuilder.CreateConfigOnlyHost(args);
    var service = host.Services.GetRequiredService<PiployService>();
    await service.WipeAll(tokenSource.Token);
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
AddCommand("service-start", "Run as service", StartService);
AddCommand("service-stop", "Run as service", StopService);
AddCommand("poll", "Poll for changes now", Poll);
AddCommand("wipeall", "Wipes out all local repos, docker images and containers", WipeAll);

await rootCommand.InvokeAsync(args);