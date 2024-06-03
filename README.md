## Overview
The basic idea of this tool:

You register a git repo + docker commands to run the service and this tool will make sure they are always running.

## TODO

- Console command on the pi to force a git pull
- Polling git
- Git commit hook + minimal web server on the pi to receive the hook so we dont have to poll at all
- Dashboard
- Do we need: https://github.com/octokit/octokit.net ?
- TODO: Make sure the name property is only a-z 0-9 - _ so we are safe for filesystems

## How a full workflow works

Check that piploy status
> ./piploy -status


## Build self contained
> dotnet publish -c Release --runtime linux-arm64 --self-contained -p:PublishSingleFile=true

Copy over to the pi

> sudo chmod +x ./piploy

> ./piploy

Dont forget to chmod +x ... after copying

## Install dotnet on the pi

TODO: Install dotnet

## Build and start the tool
Publish:
dotnet publish -c Release -o /home/irudd/Piploy

Service:
sudo nano /etc/systemd/system/piploy.service

Content:
[Unit]
Description=Raspberry pi + docker deployment tool

[Service]
WorkingDirectory=/home/irudd/Piploy
ExecStart=/usr/bin/dotnet /home/irudd/Piploy/Irudd.Piploy.dll
Restart=always
RestartSec=10
SyslogIdentifier=piploy
User=irudd
Environment=ASPNETCORE_ENVIRONMENT=Production

[Install]
WantedBy=multi-user.target

Register daemon:
sudo systemctl daemon-reload
sudo systemctl enable piploy.service

Start daemon:
sudo systemctl start piploy.service

Status of daemon:
sudo systemctl status piploy.service
