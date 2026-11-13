# Distribution licensing review

Jellyfin's server source carries GNU GPL version 2. The official plugin template carries GPL version 3. This plugin references Jellyfin server assemblies and must be reviewed for compliance before public distribution.

The repository currently carries an All Rights Reserved license. That notice alone does not establish permission to distribute a plugin linked with GPL components. A copyright-owner decision on a compatible license for the plugin, and any corresponding-source obligations, is required before publication. This review does not change the license of the application.

The ZIP contains the SameRow assembly and metadata. It excludes Jellyfin server assemblies. Excluding those DLLs does not by itself settle linking or derivative-work obligations.

Primary references:
- https://github.com/jellyfin/jellyfin/blob/master/LICENSE
- https://github.com/jellyfin/jellyfin-plugin-template/blob/master/LICENSE

The catalog manifest is empty until an actual public release exists. The packaging command can generate a release entry only after downloading a published ZIP and verifying its bytes against the local artifact.
