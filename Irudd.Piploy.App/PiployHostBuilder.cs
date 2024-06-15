using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using System.CommandLine;
using System.CommandLine.Invocation;

namespace Irudd.Piploy.App;

internal class PiployHostBuilder
{
    public static RootCommand CreateCommandlineRunner(string[] args, CancellationToken cancellationToken)
    {
        async Task Status(InvocationContext context)
        {
            var host = CreateConfigOnlyHost(args);
            var service = host.Services.GetRequiredService<PiployService>();
            var statusText = await service.GetStatusText(cancellationToken);
            Console.WriteLine(statusText);
        }

        async Task StartService(InvocationContext context)
        {
            var host = CreateServiceHost(args);
            await host.RunAsync();
        }

        async Task StopService(InvocationContext context)
        {
            await PiployBackgroundService.SendCommand("stop", cancellationToken);
        }

        async Task Poll(InvocationContext context)
        {
            if (await PiployBackgroundService.IsBackgroundServiceRunning(cancellationToken))
            {
                Console.WriteLine("Background service running. Sending the poll command there");
                await PiployBackgroundService.SendCommand("poll", cancellationToken);
            }
            else
            {
                var host = CreateConfigOnlyHost(args);
                var service = host.Services.GetRequiredService<PiployService>();
                await service.Poll(cancellationToken);
            }
        }

        async Task WipeAll(InvocationContext context)
        {
            var host = CreateConfigOnlyHost(args);
            var service = host.Services.GetRequiredService<PiployService>();
            await service.WipeAll(cancellationToken);
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

        return rootCommand;
    }

    private static IHost CreateServiceHost(string[] args) =>
        CreateBuilderWithConfigOnly(args)
        .ConfigureServices((hostContext, services) =>
        {
            services.AddHostedService<PiployBackgroundService>();
        })
        .Build();

    private static IHost CreateConfigOnlyHost(string[] args) => CreateBuilderWithConfigOnly(args).Build();


    private static IHostBuilder CreateBuilderWithConfigOnly(string[] args) => Host
        .CreateDefaultBuilder(args)
        .ConfigureAppConfiguration(x => x.AddJsonFile("piploy.json"))
        .UseConsoleLifetime()
        .ConfigureServices((context, services) =>
        {
            services.AddOptions<PiploySettings>()
                .BindConfiguration("Piploy")
                .ValidateDataAnnotations()
                .ValidateOnStart();
            services.AddScoped<PiployGitService>();
            services.AddScoped<PiployDockerService>();
            services.AddScoped<PiployDockerCleanupService>();
            services.AddScoped<PiployService>();
        })
        .ConfigureLogging(logging =>
        {
            logging.ClearProviders();
            logging.AddConsole();
            logging.AddPiployRotatingFileLogger();
        });
}
