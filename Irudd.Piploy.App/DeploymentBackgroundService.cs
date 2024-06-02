using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Irudd.Piploy.App;

public class DeploymentBackgroundService(ILogger<DeploymentBackgroundService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            logger.LogInformation("Worker running at: {time}", DateTimeOffset.Now);
            await Task.Delay(1000, stoppingToken);
        }    
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        logger.LogInformation("Worker is stopping.");
                
        await base.StopAsync(cancellationToken);
    }
}
