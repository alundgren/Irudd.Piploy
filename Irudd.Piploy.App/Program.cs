using Irudd.Piploy.App;
using System.CommandLine;

using CancellationTokenSource tokenSource = new CancellationTokenSource();

var rootCommand = PiployHostBuilder.CreateCommandlineRunner(args, tokenSource.Token);

await rootCommand.InvokeAsync(args);