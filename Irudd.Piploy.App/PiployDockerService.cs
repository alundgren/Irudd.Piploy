﻿using Docker.DotNet;
using Docker.DotNet.Models;
using Microsoft.Extensions.Options;
using System.Formats.Tar;
using static System.Net.Mime.MediaTypeNames;

namespace Irudd.Piploy.App;

public class PiployDockerService(IOptions<PiploySettings> settings)
{
    const string Piploy = "piploy";

    /*
     Docker library: 
     https://github.com/dotnet/Docker.DotNet/
     Real usage examples: 
     https://github.com/testcontainers/testcontainers-dotnet/blob/6688b92d217e710a773e87126fc98c78b27de253/src/Testcontainers/Clients/DockerImageOperations.cs#L127-L139
     */

    private PiploySettings Settings => settings.Value;

    public async Task<(bool WasCreated, string ImageId)> EnsureImageExists(PiploySettings.Application application, GitCommit commit, CancellationToken cancellationToken)
    {
        using var docker = new DockerClientConfiguration().CreateClient();

        var versionTag = GetImageVersionTag(application.Name, commit);

        var existingImage = await GetExistingImageByVersion(docker, versionTag, cancellationToken);

        if (existingImage != null)
            return (false, existingImage.ID);

        //TODO: Check if already correct version

        var (repoRelativeDockerContextDirectory, dockerfilename) = GetDockerfilePathFromSetting(application.DockerfilePath);
        var absoluteRepoDirectory = application.GetRepoDirectory(Settings);
        var absoluteDockerContextDirectory = Path.Combine(absoluteRepoDirectory, repoRelativeDockerContextDirectory);

        var absoluteDockerfilePath = Path.Combine(absoluteDockerContextDirectory, dockerfilename);
        if (!File.Exists(absoluteDockerfilePath))
            throw new Exception($"Dockerfile '{application.DockerfilePath} does not exist. Expected location: '{absoluteDockerfilePath}'");

        using var tarFile = new MemoryStream();
        await TarFile.CreateFromDirectoryAsync(absoluteDockerContextDirectory, tarFile, false, cancellationToken: cancellationToken);
        tarFile.Position = 0;

        await docker.Images.BuildImageFromDockerfileAsync(new ImageBuildParameters
        {
            Tags = new List<string>
            {
                GetImageVersionTag(application.Name, "latest"),
                versionTag,
            },
            BuildArgs = new Dictionary<string, string>(), //TODO: Figure out what goes here
            Labels = new Dictionary<string, string>
            {
                [$"{Piploy}_buildDate"] = DateTimeOffset.UtcNow.ToString("u"),
                [ImageAppLabelName] = application.Name,
                [$"{Piploy}_gitTipCommit"] = commit.Value
            },
            Dockerfile = dockerfilename //NOTE: This is just the name since the tarfile we send has the docker context directory as it's root
        },
        tarFile, Array.Empty<AuthConfig>(), new Dictionary<string, string>(),
        new ProgressTracer(), cancellationToken: cancellationToken);

        existingImage = await GetExistingImageByVersion(docker, versionTag, cancellationToken);

        if (existingImage == null)
            throw new Exception($"Failed to create image for {application.Name}");
        
        return (true, existingImage.ID);
    }

    public async Task<(bool WasCreated, bool WasStarted, string ContainerId)> EnsureContainerRunning(PiploySettings.Application application, GitCommit commit, CancellationToken cancellationToken)
    {
        using var docker = new DockerClientConfiguration().CreateClient();

        var containerName = $"{Piploy}_{application.Name}";

        var existingContainer = await GetExistingContainerByName(docker, containerName, cancellationToken);

        if(existingContainer != null)
        {
            //TODO: Check if already correct version and then just start it
            await docker.Containers.StopContainerAsync(existingContainer.ID, new ContainerStopParameters
            {
                WaitBeforeKillSeconds = 5 //TODO: Configurable per app
            }, cancellationToken);
        }

        var imageTag = GetImageVersionTag(application.Name, commit);

        var createContainerParameters = new CreateContainerParameters
        {
            Image = imageTag,
            Name = containerName,
            HostConfig = new HostConfig
            {
                //TODO: Port bindings from settings
                PortBindings = new Dictionary<string, IList<PortBinding>>
                {
                    { "80/tcp", new List<PortBinding> { new PortBinding { HostPort = "8084" } } }
                },
                AutoRemove = true
            }
        };

        var response = await docker.Containers.CreateContainerAsync(createContainerParameters, cancellationToken: cancellationToken);
        //TODO: Logg this Output.WriteLine(JsonConvert.SerializeObject(response));
        if (response.ID == null)
            throw new Exception($"Failed to create container for {application.Name}. Image used: {imageTag}.");

        try
        {
            bool wasStarted = await docker.Containers.StartContainerAsync(response.ID, new ContainerStartParameters());

            return (true, wasStarted, response.ID);
        }
        catch(DockerApiException ex)
        {
            if (ex.Message.Contains("port is already allocated"))
                throw new Exception("Port is already allocated"); //TODO: Can we figure out by what?
            throw;
        }
    }

    /// <summary>
    /// Delete images and containers created by us.
    /// By default only removes unused images and containers but
    /// with alsoRemoveActive = true we remove everything.
    /// 
    /// NOTE: We lean on that all our containers are created with delete on stop
    ///       hence why no deletes for containers.
    /// </summary>
    /// <param name="alsoRemoveActive"></param>
    public async Task Cleanup(CancellationToken cancellationToken, bool alsoRemoveActive = false)
    {
        using var docker = new DockerClientConfiguration().CreateClient();

        var allPiployImages = (await docker.Images.ListImagesAsync(new ImagesListParameters
            {
                All = true
            }, cancellationToken: cancellationToken))
            .Where(x => x.Labels.ContainsKey(ImageAppLabelName))
        .ToList();

        var allImageIds = allPiployImages.Select(x => x.ID).ToHashSet();

        var allPiployContainers = (await docker.Containers.ListContainersAsync(new ContainersListParameters { All = true })).Where(x => allImageIds.Contains(x.ImageID)).ToList();

        var latestApplicationTags = Settings.Applications.Select(x => GetImageVersionTag(x.Name, "latest")).ToHashSet();
        bool HasLatestTag(ImagesListResponse image) => (image.RepoTags ?? new List<string>()).Intersect(latestApplicationTags).Any();

        //Stop containers if needed
        foreach (var container in allPiployContainers)
        {
            var containerImage = allPiployImages.Single(x => x.ID == container.ImageID);
            var isKept = HasLatestTag(containerImage) && !alsoRemoveActive;
            if (!isKept)
                await docker.Containers.StopContainerAsync(container.ID, new ContainerStopParameters(), cancellationToken);
        }

        var allParentImageIds = allPiployImages.Where(x => x.ParentID != null).Select(x => x.ParentID).ToHashSet();
        //All non intermediate images
        var allActualImages = allPiployImages.Where(x => !allParentImageIds.Contains(x.ID)).ToList();


        var imagesToDelete = alsoRemoveActive
            ? allActualImages
            : allActualImages.Where(x => !HasLatestTag(x)).ToList();

        foreach(var imageToDelete in imagesToDelete)
        {
            await docker.Images.DeleteImageAsync(imageToDelete.ID, new ImageDeleteParameters { Force = true }, cancellationToken);
        }
    }

    private async Task<ImagesListResponse?> GetExistingImageByVersion(DockerClient docker, string versionTag, CancellationToken cancellationToken) =>
        (await docker.Images.ListImagesAsync(new ImagesListParameters
        {
            Filters = new Dictionary<string, IDictionary<string, bool>>
            {
                { "reference", new Dictionary<string, bool> { { versionTag, true } } }
            }
        }, cancellationToken: cancellationToken)).FirstOrDefault();

    private async Task<ContainerListResponse?> GetExistingContainerByName(DockerClient docker, string containerName, CancellationToken cancellationToken) =>
        (await docker.Containers.ListContainersAsync(new ContainersListParameters
        {
            Filters = new Dictionary<string, IDictionary<string, bool>>
                        {
                            { "name", new Dictionary<string, bool> { { containerName, true } } }
                        }
        })).FirstOrDefault();

    //NOTE: Docker will throw if the reference is not all lowercase
    private string GetImageVersionTag(string appName, string versionValue) => $"{Piploy}/{appName}:{versionValue}".ToLowerInvariant();
    private static string ImageAppLabelName => $"{Piploy}_appName";

    private string GetImageVersionTag(string appName, GitCommit commit) => GetImageVersionTag(appName, commit.Value);

    public static (string ContextDirectory, string Dockerfilename) GetDockerfilePathFromSetting(string dockerPathSetting)
    {
        //Normalize to format <path>/<filename> where path is repeating segments like <name>/
        var d = dockerPathSetting.Replace(@"\", "/").Trim();
        d = d.StartsWith("/") ? d.Substring(1) : d;
        if (d.EndsWith("/"))
            throw new Exception("Invalid DockerfilePath. It must point to a dockerfile relative to the repository root. Examples: 'Dockerfile' or 'SubDirectory/Dockerfile' or Dockerfile.custom'");

        var segments = d.Split('/');
        if (segments.Length == 1)
            return ("", segments[0]);
        else
            return (string.Join("/", segments.Take(segments.Length - 1)), segments.Last());
    }

    private class ProgressTracer : IProgress<JSONMessage>
    {
        public void Report(JSONMessage value) {} //TODO: Log JSonConvert.SerializeObject ... seems to be just one filled out at a time
    }
    /*
    public async Task EnsureContainerExistsAndIsRunning(PiploySettings.Application application, CancellationToken cancellationToken)
    {
        throw new NotImplementedException();
    }

    public async Task PruneUnusedImages(PiploySettings.Application application, CancellationToken cancellationToken)
    {
        throw new NotImplementedException();
    }
    */
}
