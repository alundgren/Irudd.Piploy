using Docker.DotNet.Models;
using Docker.DotNet;

namespace Irudd.Piploy.App;

public class PiployDockerCleanupService
{
    /// <summary>
    /// Delete images and containers created by us.
    /// Keeps the latest version of each application and it's running containers.
    /// </summary>
    public async Task CleanupInactive(CancellationToken cancellationToken, List<PiploySettings.Application> applications)
    {
        using var docker = new DockerClientConfiguration().CreateClient();

        var allPiployImages = await GetAllPiployImages(docker, cancellationToken);

        var latestApplicationTags = applications.Select(x => PiployDockerService.GetImageVersionTagLatest(x.Name)).ToHashSet();
        bool HasLatestTag(ImagesListResponse image) => (image.RepoTags ?? new List<string>()).Intersect(latestApplicationTags).Any();

        var imagesToDelete = allPiployImages.Where(x => !HasLatestTag(x)).ToList();

        await StopContainersAndDeleteImages(docker, imagesToDelete, cancellationToken);
    }

    /// <summary>
    /// Delete all images and containers created by us including running containers and the latest version of images
    /// </summary>
    public async Task CleanupAll(CancellationToken cancellationToken)
    {
        using var docker = new DockerClientConfiguration().CreateClient();

        var allPiployImages = await GetAllPiployImages(docker, cancellationToken);

        await StopContainersAndDeleteImages(docker, allPiployImages, cancellationToken);
    }

    /// <summary>
    /// Delete all images and containers created by our integration tests
    /// </summary>
    public async Task CleanupTestCreated(CancellationToken cancellationToken)
    {
        using var docker = new DockerClientConfiguration().CreateClient();

        var allPiployImages = await GetAllPiployImages(docker, cancellationToken);

        var testImages = allPiployImages.Where(x => x.Labels.ContainsKey(PiployDockerService.TestMarkerLabelName)).ToList();

        await StopContainersAndDeleteImages(docker, testImages, cancellationToken);
    }

    private async Task<List<ImagesListResponse>> GetAllPiployImages(DockerClient docker, CancellationToken cancellationToken) =>    
        (await docker.Images
            .ListImagesAsync(new ImagesListParameters { All = true }, cancellationToken: cancellationToken))
            .Where(x => 
                //Make sure its a piploy image
                x.Labels != null && x.Labels.ContainsKey(PiployDockerService.ImageAppLabelName) && 
                //Remove intermediate (all our containers have at least the uuid version tag)
                x.RepoTags != null && x.RepoTags.Count > 0)
            .ToList();

    private async Task StopContainersAndDeleteImages(DockerClient docker, List<ImagesListResponse> images, CancellationToken cancellationToken)
    {
        var imageIds = images.Select(x => x.ID).ToHashSet();
        var containers = (await docker.Containers
            .ListContainersAsync(new ContainersListParameters { All = true }))
            .Where(x => imageIds.Contains(x.ImageID))
            .ToList();

        foreach (var container in containers)
        {
            await docker.Containers.StopContainerAsync(container.ID, new ContainerStopParameters(), cancellationToken);
        }

        foreach (var image in images)
        {
            await docker.Images.DeleteImageAsync(image.ID, new ImageDeleteParameters { Force = true }, cancellationToken);
        }

        //Remove dangling images (docker image prune)
        await docker.Images.PruneImagesAsync(parameters: new ImagesPruneParameters 
        {
            Filters = new Dictionary<string, IDictionary<string, bool>>
            {
                ["dangling"] = new Dictionary<string, bool> { ["true"] = true }
            }
        }, cancellationToken);
    }
}
