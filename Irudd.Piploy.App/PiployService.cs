﻿using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Irudd.Piploy.App;

public class PiployService(PiployDockerService docker, PiployGitService git, IOptions<PiploySettings> settings, ILogger<PiployService> logger)
{
    public async Task Poll(CancellationToken cancellationToken)
    {
        using var _ = logger.BeginPiployOperationScope("poll");

        foreach (var application in settings.Value.Applications)
        {
            using var __ = logger.BeginPiployApplicationScope(application.Name);

            git.EnsureLocalRepository(application);
            var latestCommit = git.GetLatestCommit(application);            
            var (wasImageCreated, imageId) = await docker.EnsureImageExists(application, latestCommit, cancellationToken);
            var (wasContainerCreated, wasContainerStarted, containerId) = await docker
                .EnsureContainerRunning(application, latestCommit, cancellationToken);
        }
        await docker.Cleanup.CleanupInactive(cancellationToken, settings.Value.Applications);
    }

    public async Task WipeAll(CancellationToken cancellationToken)
    {
        using var _ = logger.BeginPiployOperationScope("wipeall");
        await docker.Cleanup.CleanupAll(cancellationToken);
        DeleteRootDirectory();
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
