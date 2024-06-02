using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace Irudd.Piploy.App;

internal class HostBuilder
{
    public static IHost CreateServiceHost(string[] args) =>    
        CreateBuilderWithConfigOnly(args)
        .ConfigureServices((hostContext, services) =>
        {
            services.AddHostedService<DeploymentBackgroundService>();
        })
        .ConfigureLogging(logging =>
        {
            logging.ClearProviders();
            logging.AddConsole();
        })
        .Build();

    public static IHost CreateConfigOnlyHost(string[] args) => CreateBuilderWithConfigOnly(args).Build();

    private static IHostBuilder CreateBuilderWithConfigOnly(string[] args) => Host
        .CreateDefaultBuilder(args)
        .ConfigureAppConfiguration(x => x.AddJsonFile("piploy.json"))
        .ConfigureServices((context, services) =>
        {
            services.AddOptions<PiploySettings>()
                .BindConfiguration("Piploy")
                .ValidateDataAnnotations()
                .ValidateOnStart(); ;
        });
}
