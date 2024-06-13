using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using System.Text;

namespace Irudd.Piploy.App;

public class PiployService(PiployDockerService docker, PiployGitService git, IOptions<PiploySettings> settings, ILogger<PiployService> logger)
{
    public async Task Poll(CancellationToken cancellationToken)
    {
        using var _ = logger.BeginPiployOperationScope("poll");

        logger.LogInformation("Polling applications");
        foreach (var application in settings.Value.Applications)
        {
            logger.LogInformation($"Polling application: {application.Name}");
            using var __ = logger.BeginPiployApplicationScope(application.Name);

            git.EnsureLocalRepository(application);
            var latestCommit = git.GetLatestCommit(application);            
            var (wasImageCreated, imageId) = await docker.EnsureImageExists(application, latestCommit, cancellationToken);
            var (wasContainerCreated, wasContainerStarted, containerId) = await docker
                .EnsureContainerRunning(application, latestCommit, cancellationToken);
        }
        logger.LogInformation("Cleaning up unused images");
        await docker.Cleanup.CleanupInactive(cancellationToken, settings.Value.Applications);
    }

    public async Task WipeAll(CancellationToken cancellationToken)
    {
        using var _ = logger.BeginPiployOperationScope("wipeall");
        await docker.Cleanup.CleanupAll(cancellationToken);
        DeleteRootDirectory();
    }

    public async Task<string> GetStatusText(CancellationToken cancellationToken)
    {
        var text = new StringBuilder();

        string GetCommitText(GitCommit? c) => c == null ? "Not cloned" : $"{c.Hash}: {c.Date:o}{Environment.NewLine}{c.Message}";

        text.AppendLine($"------- Piploy status -------");
        var isBackgroundServiceRunning = await PiployBackgroundService.IsBackgroundServiceRunning(cancellationToken);
        text.AppendLine($"Background service running: {(isBackgroundServiceRunning ? "Yes" : "No")}");
        text.AppendLine();

        foreach (var application in settings.Value.Applications)
        {
            text.AppendLine($"------- Application: {application.Name} -------");
            
            var commitStatus = git.GetCommitStatus(application);
            var dockerStatus = await docker.GetDockerStatus(application, cancellationToken);
            var isRunningTheLatestVersion = commitStatus.HasValue
                && dockerStatus.RunningContainerHash != null
                && commitStatus.Value.LatestRemote.Hash == dockerStatus.RunningContainerHash;

            text.AppendLine("Is running the latest version:");
            text.AppendLine(isRunningTheLatestVersion ? "Yes" : "No");
            text.AppendLine();

            text.AppendLine("Latest local commit:");
            text.AppendLine(GetCommitText(commitStatus?.LatestLocal));
            text.AppendLine();

            text.AppendLine("Latest remote commit:");
            text.AppendLine(GetCommitText(commitStatus?.LatestRemote));
            text.AppendLine();

            text.AppendLine("Latest image commit hash: ");
            text.AppendLine($"{dockerStatus.LatestImageHash ?? "-"}");
            text.AppendLine();

            text.AppendLine("Running container commit hash: ");
            text.AppendLine($"{dockerStatus.RunningContainerHash?? "-"}");
            text.AppendLine();
        }
        return text.ToString();
    }

    private void DeleteRootDirectory()
    {
        var rootDirectory = settings.Value.RootDirectory;
        if (!Directory.Exists(rootDirectory))
            return;

        //Remove readonly so we can delete .git content without access denied errors
        foreach (var directory in new DirectoryInfo(rootDirectory).GetFileSystemInfos("*", SearchOption.AllDirectories))
            File.SetAttributes(directory.FullName, FileAttributes.Normal);

        Directory.Delete(rootDirectory, true);
    }
}
