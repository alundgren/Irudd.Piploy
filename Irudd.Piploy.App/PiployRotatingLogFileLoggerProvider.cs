using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Configuration;
using Microsoft.Extensions.Options;
using System.Globalization;
using System.Collections.Concurrent;

namespace Irudd.Piploy.App;

[ProviderAlias("Piploy")]
public class PiployRotatingLogFileLoggerProvider(IOptions<PiploySettings> settings) : ILoggerProvider, ILogger
{
    private static readonly object writeLock = new object();

    public ILogger CreateLogger(string categoryName)
    {
        return this;
    }

    public void Dispose() { }

    private ConcurrentDictionary<string, string> scopes = new ConcurrentDictionary<string, string>();
    private class ScopeRemover(ConcurrentDictionary<string, string> d, string key) : IDisposable
    {
        public void Dispose() => d.Remove(key, out _);        
    }

    public IDisposable? BeginScope<TState>(TState state) where TState : notnull
    {
        if (state is PiployLogScope p)
        {
            scopes[p.Key] = p.Value;
            return new ScopeRemover(scopes, p.Key);
        }
        else
            return null;
    }

    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
    {
        string message = formatter(state, exception);
        if (string.IsNullOrWhiteSpace(message))
            return;

        var scopePrefix = $"[{string.Join(", ", scopes.ToList().Select(x => $"{x.Key}={x.Value}"))}]";
        lock (writeLock)
        {
            /*
             Rotate logs every week.
             We assume that docker operations are so slow that wasting some work here by doing the checks on every log call doesnt really matter.
             If this turns out not to be true we may need some optimization here.
             */
            var now = DateTimeOffset.UtcNow;
            var weekNr = CultureInfo.InvariantCulture.Calendar.GetWeekOfYear(now.UtcDateTime, CalendarWeekRule.FirstDay, DayOfWeek.Monday);
            var logFolder = GetLogFolder(settings.Value);
            var logFilename = $"piploy-log-{now.Year}-{weekNr}.txt";            
            foreach(var file in new DirectoryInfo(logFolder).GetFiles("piploy-log-*").Where(x => x.Name != logFilename).ToList())
            {
                file.Delete();
            }

            File.AppendAllText(Path.Combine(logFolder, logFilename), 
                $"{DateTimeOffset.UtcNow.ToString("yyyy-MM-dd HH:mm:ss")} {scopePrefix} {message}{Environment.NewLine}");
        }
    }

    private static string GetLogFolder(PiploySettings settings) => Path.Combine(settings.RootDirectory, "logs");
    public static void EnsureLogFolderExists(PiploySettings settings) => Directory.CreateDirectory(GetLogFolder(settings));
}

public static class PiployLoggerExtensions
{
    public static ILoggingBuilder AddPiployRotatingFileLogger(this ILoggingBuilder builder)
    {
        builder.AddConfiguration();
        builder.Services.TryAddEnumerable(ServiceDescriptor.Singleton<ILoggerProvider, PiployRotatingLogFileLoggerProvider>(x =>
        {
            var settings = x.GetRequiredService<IOptions<PiploySettings>>();
            PiployRotatingLogFileLoggerProvider.EnsureLogFolderExists(settings.Value);
            return new PiployRotatingLogFileLoggerProvider(settings);
        }));
        return builder;
    }
}

public class PiployLogScope(string key, string value)
{
    public string Key => key;
    public string Value => value;
}

public static class PiployILoggerExtensions
{
    public static IDisposable? BeginPiployScope<T>(this ILogger<T> source, string key, string value) => 
        source.BeginScope(new PiployLogScope(key, value));
    public static IDisposable? BeginPiployApplicationScope<T>(this ILogger<T> source, string value) => 
        source.BeginPiployScope("application", value);
    public static IDisposable? BeginPiployOperationScope<T>(this ILogger<T> source, string value) =>
        source.BeginPiployScope("operation", value);
}