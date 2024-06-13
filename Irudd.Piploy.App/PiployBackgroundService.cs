using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using System.Collections.Concurrent;
using System.IO.Pipes;

namespace Irudd.Piploy.App;

public class PiployBackgroundService(ILogger<PiployBackgroundService> logger, IHostApplicationLifetime application,
    PiployService piploy, IOptions<PiploySettings> settings) : BackgroundService
{
    private const string CommandPipeName = "piploy_pipe";
    private CancellationTokenSource? cancellationSource;

    protected override Task ExecuteAsync(CancellationToken stoppingToken)
    {
        cancellationSource = CancellationTokenSource.CreateLinkedTokenSource(application.ApplicationStopping);

        logger.LogInformation($"Worker starting at: {DateTimeOffset.Now}");

        var commands = new BlockingCollection<string>(1000);

        ThreadPool.QueueUserWorkItem(async _ =>
            await ListenForCommands(commands, cancellationSource.Token));

        ThreadPool.QueueUserWorkItem(async _ =>
            await RunQueuedCommands(commands, cancellationSource.Token));

        ThreadPool.QueueUserWorkItem(async _ =>
            await QueuePollPeriodically(
                commands,
                TimeSpan.FromMinutes(settings.Value.MinutesBetweenBackgroundPolls ?? 60),
                cancellationSource.Token));

        return Task.CompletedTask;
    }

    private async Task RunQueuedCommands(BlockingCollection<string> commands, CancellationToken cancellationToken)
    {
        logger.LogInformation($"Command worker starting");
        while (!cancellationToken.IsCancellationRequested)
        {
            var command = commands.Take(cancellationToken);
            logger.LogInformation($"Executing command: {command}");
            if (command == "stop")
            {
                application.StopApplication();
            }
            else if(command == "donothing")
            {
                //Connection test from IsBackgroundServiceRunning
            }
            else
            {
                try
                {
                    if (command == "poll")
                    {
                        await piploy.Poll(cancellationToken);
                    }
                }
                catch (Exception ex)
                {
                    logger.LogError(ex, $"Command {command} failed to execute");
                }
            }
        }

        logger.LogInformation($"Command worker stopping");
    }

    private async Task ListenForCommands(BlockingCollection<string> commands, CancellationToken cancellationToken)
    {
        logger.LogInformation($"Command server starting");
        using var commandServer = new NamedPipeServerStream("piploy_pipe", PipeDirection.In);        
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                logger.LogInformation($"Waiting for commands");
                await commandServer.WaitForConnectionAsync(cancellationToken);
                using var commandReader = new StreamReader(commandServer, leaveOpen: true);
                var command = await commandReader.ReadLineAsync();
                commandServer.Disconnect();
                if (command != null)
                {
                    logger.LogInformation($"Received command: {command}");
                    if (!commands.TryAdd(command, 0, cancellationToken))
                        logger.LogInformation($"Command queue is full. Dropping: {command}");
                }                
            }
        }
        catch (OperationCanceledException)
        {
            logger.LogInformation("Command server shutting down");
        }
    }

    private async Task QueuePollPeriodically(BlockingCollection<string> commands, TimeSpan waitBetweenCalls, CancellationToken cancellationToken)
    {
        //Dont instantly poll when starting
        await Task.Delay(TimeSpan.FromSeconds(2), cancellationToken);

        while (!cancellationToken.IsCancellationRequested)
        {
            logger.LogInformation("Queueing periodic poll");
            if (!commands.TryAdd("poll", 0, cancellationToken))
                logger.LogInformation("Command queue full. Skipping periodic poll");

            await Task.Delay(waitBetweenCalls, cancellationToken);
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        logger.LogInformation("Worker is stopping.");

        cancellationSource?.Cancel();
        cancellationSource?.Dispose();
        cancellationSource = null;

        await base.StopAsync(cancellationToken);
    }

    //This number was picked based on basically nothing. No idea what is a reasonable number here.
    private static TimeSpan CommandServerConnectionTimeout = TimeSpan.FromMilliseconds(200);

    public static async Task<bool> IsBackgroundServiceRunning(CancellationToken cancellationToken)
    {
        try
        {
            await SendCommand("donothing", cancellationToken);
            return true;
        }
        catch(TimeoutException)
        {
            return false;
        }
    }

    public static async Task SendCommand(string command, CancellationToken cancellationToken)
    {
        using var client = new NamedPipeClientStream(".", CommandPipeName, PipeDirection.Out);
        await client.ConnectAsync(CommandServerConnectionTimeout, cancellationToken);
        using var writer = new StreamWriter(client);
        writer.AutoFlush = true;
        await writer.WriteLineAsync(command);
    }
}
