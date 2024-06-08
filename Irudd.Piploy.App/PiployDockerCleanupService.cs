using Docker.DotNet.Models;
using Docker.DotNet;

namespace Irudd.Piploy.App;

public class PiployDockerCleanupService
{
    /// <summary>
    /// Delete images and containers created by us.
    /// Keeps the latest version of each application and it's running containers.
    /// 
    /// NOTE: We lean on that all our containers are created with delete on stop
    ///       hence why no deletes for containers.
    /// </summary>
    /// <param name="alsoRemoveActive"></param>
    public async Task CleanupInactive(CancellationToken cancellationToken, List<PiploySettings.Application> applications)
    {
        using var docker = new DockerClientConfiguration().CreateClient();

        var (allPiployImages, allPiployContainers) = await GetAllPiployImagesAndContainers(docker, cancellationToken);

        var latestApplicationTags = applications.Select(x => PiployDockerService.GetImageVersionTag(x.Name, "latest")).ToHashSet();
        bool HasLatestTag(ImagesListResponse image) => (image.RepoTags ?? new List<string>()).Intersect(latestApplicationTags).Any();

        var imagesIdsToKeep = allPiployImages.Where(HasLatestTag).Select(x => x.ID).ToHashSet();

        var containersToStop = allPiployContainers.Where(x => !imagesIdsToKeep.Contains(x.ImageID)).ToList();
        await StopContainers(docker, containersToStop, cancellationToken);

        var imagesToDelete = allPiployImages.Where(x => !imagesIdsToKeep.Contains(x.ID)).ToList();
        await DeleteImages(docker, imagesToDelete, cancellationToken);
    }

    /// <summary>
    /// Delete all images and containers created by us including running containers and the latest version
    /// of images
    /// 
    /// NOTE: We lean on that all our containers are created with delete on stop
    ///       hence why no deletes for containers.
    /// </summary>
    public async Task CleanupAll(CancellationToken cancellationToken)
    {
        using var docker = new DockerClientConfiguration().CreateClient();

        var (allPiployImages, allPiployContainers) = await GetAllPiployImagesAndContainers(docker, cancellationToken);

        await StopContainers(docker, allPiployContainers, cancellationToken);
        await DeleteImages(docker, allPiployImages, cancellationToken);
    }

    private async Task<(List<ImagesListResponse> Images, List<ContainerListResponse> Containers)> GetAllPiployImagesAndContainers(DockerClient docker, CancellationToken cancellationToken)
    {
        var images = (await docker.Images
            .ListImagesAsync(new ImagesListParameters { All = true }, cancellationToken: cancellationToken))
            .Where(x => 
                //Make sure its a piploy image
                x.Labels.ContainsKey(PiployDockerService.ImageAppLabelName) && 
                //Remove intermediate (all our containers have at least the uuid version tag)
                x.RepoTags != null && x.RepoTags.Count > 0)
            .ToList();

        var allImageIds = images.Select(x => x.ID).ToHashSet();

        var containers = (await docker.Containers
            .ListContainersAsync(new ContainersListParameters { All = true }))
            .Where(x => allImageIds.Contains(x.ImageID))
            .ToList();

        return (Images: images, Containers: containers);
    }

    private async Task StopContainers(DockerClient docker, List<ContainerListResponse> containers, CancellationToken cancellationToken)
    {
        foreach (var container in containers)
        {
            await docker.Containers.StopContainerAsync(container.ID, new ContainerStopParameters(), cancellationToken);
        }
    }

    private async Task DeleteImages(DockerClient docker, List<ImagesListResponse> images, CancellationToken cancellationToken)
    {
        foreach (var image in images)
        {
            await docker.Images.DeleteImageAsync(image.ID, new ImageDeleteParameters { Force = true }, cancellationToken);
        }
    }
}
